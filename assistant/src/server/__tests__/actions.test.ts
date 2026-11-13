import { afterAll, describe, expect, test } from "bun:test";
import { ActionStore } from "../actions";
import { createAssistant } from "../app";
import { MemoryAuditLog } from "../audit";
import { loadConfig } from "../config";
import { AppClient } from "../products";
import { RateLimiter } from "../ratelimit";
import { buildTools } from "../tools";
import { MemoryTicketStore, TicketService } from "../tickets";
import { RECORDS, SECRET, startFakeApp, startFakeReport, writes } from "./fakes";

const app = startFakeApp();
const report = startFakeReport();
afterAll(() => {
  app.stop(true);
  report.server.stop(true);
});

const env = {
  CHAT_BRIDGE_SECRET: SECRET,
  APP_API_URL: `http://127.0.0.1:${app.port}`,
  REPORT_URL: `http://127.0.0.1:${report.server.port}`,
  PUBLIC_ORIGIN: "http://localhost",
};

function rig(extra: Record<string, string> = {}) {
  const config = loadConfig({ ...env, ...extra });
  const actions = new ActionStore(config.actionTtlSeconds);
  const audit = new MemoryAuditLog();
  const handle = createAssistant({
    config,
    audit,
    actions,
    tickets: new TicketService(new MemoryTicketStore(), 60),
  });
  const toolsFor = (token: string, email: string) =>
    buildTools({
      config,
      person: { email, name: email, roles: [], isMaster: false },
      clients: { app: new AppClient(config, `crm_app.session_token=${token}`), report: async () => { throw new Error("unused"); } },
      audit,
      actions,
    });
  const post = (token: string, path: string, headers: Record<string, string> = {}) =>
    handle(
      new Request(`http://localhost/chat${path}`, {
        method: "POST",
        body: "{}",
        headers: { cookie: `crm_app.session_token=${token}`, origin: "http://localhost", "content-type": "application/json", ...headers },
      })
    );
  return { config, actions, audit, handle, toolsFor, post };
}

const call = async (tools: ReturnType<typeof buildTools>, name: string, args: unknown): Promise<any> => {
  const tool = tools.find((candidate) => candidate.name === name) as any;
  return tool.execute(args, {});
};

describe("proposed changes", () => {
  test("a proposal writes nothing; the person's confirmation does, with the version they read", async () => {
    const r = rig();
    writes.length = 0;
    const tools = r.toolsFor("tok-sales", "sales.manager@crm.example.com");
    const proposed = await call(tools, "propose_move", { object: "bus_opportunity", id: "o1", event: "approve", title: "Acme renewal" });
    expect(proposed.awaitingConfirmation).toBe(true);
    expect(writes).toHaveLength(0);

    const confirmed = await r.post("tok-sales", `/api/actions/${proposed.proposal.id}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "POST", ifMatch: '"1"', user: "sales.manager@crm.example.com", body: { event: "approve" } });
    expect((await r.audit.recent(10)).map((e) => e.tool)).toContain("confirm_move");
  });

  test("a proposal is held to the version it was made at: a record saved since is refused", async () => {
    const r = rig();
    writes.length = 0;
    const tools = r.toolsFor("tok-sales", "sales.manager@crm.example.com");
    const { proposal } = await call(tools, "propose_update", { object: "bus_account", id: "a1", title: "Acme", changes: { industry: "Retail" } });
    // Somebody else saves the record before the person presses Confirm.
    const row = RECORDS.bus_account?.[0] as Record<string, unknown>;
    row.version = 2;
    try {
      const refused = await r.post("tok-sales", `/api/actions/${proposal.id}/confirm`);
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as { message: string }).message).toContain("VERSION_CONFLICT");
      expect(writes).toHaveLength(0);
    } finally {
      row.version = 1;
    }
  });

  test("a move the person has no button for is never proposed", async () => {
    const r = rig();
    const tools = r.toolsFor("tok-admin", "admin@admin.com");
    const proposed = await call(tools, "propose_move", { object: "bus_opportunity", id: "o1", event: "approve", title: "x" });
    expect(proposed.available).toBe(false);
    expect(proposed.awaitingConfirmation).toBeUndefined();
  });

  test("a proposal is spent once, and only its owner can use it", async () => {
    const r = rig();
    writes.length = 0;
    const tools = r.toolsFor("tok-sales", "sales.manager@crm.example.com");
    const { proposal } = await call(tools, "propose_update", { object: "bus_account", id: "a1", title: "Acme", changes: { industry: "Retail" } });
    expect((await r.post("tok-admin", `/api/actions/${proposal.id}/confirm`)).status).toBe(404);
    expect(writes).toHaveLength(0);
    expect((await r.post("tok-sales", `/api/actions/${proposal.id}/confirm`)).status).toBe(200);
    expect((await r.post("tok-sales", `/api/actions/${proposal.id}/confirm`)).status).toBe(404);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "PATCH", body: { industry: "Retail" } });
  });

  test("declining writes nothing", async () => {
    const r = rig();
    writes.length = 0;
    const tools = r.toolsFor("tok-sales", "sales.manager@crm.example.com");
    const { proposal } = await call(tools, "propose_update", { object: "bus_account", id: "a1", title: "Acme", changes: { industry: "Retail" } });
    expect((await r.post("tok-sales", `/api/actions/${proposal.id}/decline`)).status).toBe(200);
    expect((await r.post("tok-sales", `/api/actions/${proposal.id}/confirm`)).status).toBe(404);
    expect(writes).toHaveLength(0);
  });

  test("a confirmation from another site, or without JSON, is refused and spends nothing", async () => {
    const r = rig();
    writes.length = 0;
    const tools = r.toolsFor("tok-sales", "sales.manager@crm.example.com");
    const { proposal } = await call(tools, "propose_update", { object: "bus_account", id: "a1", title: "Acme", changes: { industry: "Retail" } });
    expect((await r.post("tok-sales", `/api/actions/${proposal.id}/confirm`, { origin: "https://evil.example" })).status).toBe(403);
    expect((await r.post("tok-sales", `/api/actions/${proposal.id}/confirm`, { "content-type": "text/plain" })).status).toBe(403);
    expect(writes).toHaveLength(0);
    expect((await r.post("tok-sales", `/api/actions/${proposal.id}/confirm`)).status).toBe(200);
  });

  test("system-managed fields cannot be proposed", async () => {
    const r = rig();
    const tools = r.toolsFor("tok-sales", "sales.manager@crm.example.com");
    for (const changes of [{ stage: "won" }, { version: 9 }, { created_by: "x" }, { id: "z" }]) {
      const result = await call(tools, "propose_update", { object: "bus_opportunity", id: "o1", title: "x", changes });
      expect(result.available).toBe(false);
    }
  });

  test("an expired proposal is gone", () => {
    let now = 0;
    const store = new ActionStore(300, () => now);
    const action = store.propose("a@b.c", { kind: "update", object: "bus_account", id: "a1", title: "x", changes: { a: "b" }, version: 1 });
    now = 301_000;
    expect(store.take(action.id, "a@b.c")).toBeNull();
  });
});

describe("rate limits", () => {
  test("the window counts, tells the caller when to return, and resets", () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    const limit = { max: 2, windowSeconds: 60 };
    expect(limiter.check("k", limit).ok).toBe(true);
    expect(limiter.check("k", limit).ok).toBe(true);
    const blocked = limiter.check("k", limit);
    expect(blocked).toEqual({ ok: false, retryAfterSeconds: 60 });
    expect(limiter.check("other", limit).ok).toBe(true);
    now = 61_000;
    expect(limiter.check("k", limit).ok).toBe(true);
    expect(limiter.check("k", { max: 0, windowSeconds: 60 }).ok).toBe(true);
  });

  test("a signed-in person is limited by account, and the answer is a 429 with Retry-After", async () => {
    const r = rig({ CHAT_RATE_PER_USER: "3" });
    const statuses: number[] = [];
    let last: Response | null = null;
    for (let i = 0; i < 5; i++) {
      last = await r.handle(new Request("http://localhost/chat/api/session", { headers: { cookie: "crm_app.session_token=tok-agent" } }));
      statuses.push(last.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
    // Somebody else is unaffected.
    const other = await r.handle(new Request("http://localhost/chat/api/session", { headers: { cookie: "crm_app.session_token=tok-sales" } }));
    expect(other.status).toBe(200);
  });

  test("a client cannot pick its own address by sending X-Forwarded-For", async () => {
    const r = rig({ CHAT_RATE_PER_ADDRESS: "2" });
    // nginx keeps what the client sent and appends the real address; X-Real-IP is the proxy's own.
    const get = (spoof: string) =>
      r.handle(new Request("http://localhost/chat/switches", { headers: { "x-real-ip": "198.51.100.7", "x-forwarded-for": `${spoof}, 198.51.100.7` } }));
    await get("1.1.1.1");
    await get("2.2.2.2");
    expect((await get("3.3.3.3")).status).toBe(429);
    // Without X-Real-IP, the last entry — the one the proxy appended — counts.
    const bare = (spoof: string) =>
      r.handle(new Request("http://localhost/chat/switches", { headers: { "x-forwarded-for": `${spoof}, 198.51.100.8` } }));
    await bare("4.4.4.4");
    await bare("5.5.5.5");
    expect((await bare("6.6.6.6")).status).toBe(429);
  });

  test("callers with no session are limited by address", async () => {
    const r = rig({ CHAT_RATE_PER_ADDRESS: "2" });
    const get = () => r.handle(new Request("http://localhost/chat/switches", { headers: { "x-real-ip": "203.0.113.9" } }));
    await get();
    await get();
    expect((await get()).status).toBe(429);
    const elsewhere = await r.handle(new Request("http://localhost/chat/switches", { headers: { "x-real-ip": "203.0.113.10" } }));
    expect(elsewhere.status).not.toBe(429);
  });
});
