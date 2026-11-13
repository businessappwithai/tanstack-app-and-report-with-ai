import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAssistant, EMBED_COOKIE } from "../app";
import { MemoryAuditLog } from "../audit";
import { loadConfig } from "../config";
import { verifyStatement } from "../signing";
import { MemoryTicketStore, TicketService } from "../tickets";
import { SECRET, startFakeApp, startFakeModel, startFakeReport } from "./fakes";

const app = startFakeApp();
const report = startFakeReport();
const model = startFakeModel([
  { tool: "search_records", args: { query: "acme" } },
  { tool: "open_record", args: { object: "bus_account", id: "a1", title: "Acme Corporation" } },
  { text: "I opened Acme Corporation." },
]);

const config = loadConfig({
  CHAT_BRIDGE_SECRET: SECRET,
  APP_API_URL: `http://127.0.0.1:${app.port}`,
  REPORT_URL: `http://127.0.0.1:${report.server.port}`,
  AI_BASE_URL: `http://127.0.0.1:${model.server.port}/v1`,
  AI_MODEL: "fake",
  PUBLIC_ORIGIN: "http://localhost",
});
const audit = new MemoryAuditLog();
const handle = createAssistant({
  config,
  audit,
  tickets: new TicketService(new MemoryTicketStore(), config.ticketTtlSeconds),
});

const as = (token: string | null, path: string, init: RequestInit = {}) =>
  handle(
    new Request(`http://localhost/chat${path}`, {
      ...init,
      headers: {
        ...(token ? { cookie: `crm_app.session_token=${token}` } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    })
  );

const ticketFor = async (token: string, intent: unknown) => {
  const response = await as(token, "/api/tickets", { method: "POST", body: JSON.stringify(intent) });
  return { status: response.status, body: (await response.json()) as { ticket?: string; error?: string } };
};

beforeAll(() => undefined);
afterAll(() => {
  app.stop(true);
  report.server.stop(true);
  model.server.stop(true);
});

describe("identity", () => {
  test("no session is a 401, never a guess", async () => {
    expect((await as(null, "/api/session")).status).toBe(401);
    expect((await as("tok-nobody", "/api/session")).status).toBe(401);
  });

  test("the session is the application's own account", async () => {
    const response = await as("tok-agent", "/api/session");
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.user.email).toBe("support.agent@crm.example.com");
    expect(body.user.admin).toBe(false);
    expect(response.headers.get("set-cookie")).toContain(`${EMBED_COOKIE}=`);
  });

  test("sign-in is the application's, passed through with its cookie", async () => {
    const response = await as(null, "/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: "x", password: "y" }),
    });
    expect(response.headers.getSetCookie().join()).toContain("crm_app.session_token=");
  });
});

describe("tickets and the embedded page", () => {
  test("a ticket opens the page once, and the address is not in the ticket", async () => {
    const { status, body } = await ticketFor("tok-agent", {
      product: "app",
      kind: "record",
      object: "bus_account",
      id: "a1",
      title: "Acme",
    });
    expect(status).toBe(200);
    expect(body.ticket).not.toContain("bus_account");

    const first = await as("tok-agent", `/open/${body.ticket}`);
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/app/bus_account/a1?embed=1");
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");

    const embed = /chat_embed=([^;]+)/.exec(first.headers.getSetCookie().join())?.[1];
    expect((await verifyStatement(SECRET, embed, "embed"))?.sub).toBe("support.agent@crm.example.com");

    expect((await as("tok-agent", `/open/${body.ticket}`)).status).toBe(404);
  });

  test("somebody else's ticket is refused, and is spent by the attempt", async () => {
    const { body } = await ticketFor("tok-sales", {
      product: "app",
      kind: "record",
      object: "bus_opportunity",
      id: "o1",
      title: "Renewal",
    });
    expect((await as("tok-agent", `/open/${body.ticket}`)).status).toBe(404);
    expect((await as(null, `/open/${body.ticket}`)).status).toBe(404);
    expect((await as("tok-sales", `/open/${body.ticket}`)).status).toBe(404);
  });

  test("forbidden and missing give the same answer", async () => {
    const forbidden = await ticketFor("tok-agent", {
      product: "app",
      kind: "record",
      object: "bus_opportunity",
      id: "o1",
      title: "x",
    });
    const missing = await ticketFor("tok-agent", {
      product: "app",
      kind: "record",
      object: "bus_account",
      id: "nope",
      title: "x",
    });
    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(forbidden.body).toEqual(missing.body);
  });

  test("an intent cannot carry an address", async () => {
    for (const object of ["../admin", "bus_account/../../report", "https://evil.example", "Bus_Account"]) {
      const { status } = await ticketFor("tok-admin", { product: "app", kind: "record", object, id: "a1", title: "x" });
      expect(status).toBe(404);
    }
    const { status } = await ticketFor("tok-admin", {
      product: "app",
      kind: "record",
      object: "bus_account",
      id: "a1/../../x",
      title: "x",
    });
    expect(status).toBe(404);
  });

  test("an administration page opens for the administrator only", async () => {
    const intent = { product: "app", kind: "admin", object: "/admin/users", title: "Users" };
    expect((await ticketFor("tok-admin", intent)).status).toBe(200);
    expect((await ticketFor("tok-agent", intent)).status).toBe(404);
  });
});

describe("reporting", () => {
  test("a reporting page is opened with a session delegated for the same person", async () => {
    const { body } = await ticketFor("tok-sales", {
      product: "report",
      kind: "report",
      object: "report",
      id: "r1",
      title: "Accounts by status",
    });
    const response = await as("tok-sales", `/open/${body.ticket}`);
    expect(response.headers.get("location")).toBe("/report/reports/r1/viewer?embed=1");
    expect(response.headers.getSetCookie().join()).toContain(
      "ers.session_token=for-sales.manager@crm.example.com"
    );
    expect(report.delegated).toContain("sales.manager@crm.example.com");
  });

  test("the reporting platform's own refusal stands", async () => {
    const { status } = await ticketFor("tok-agent", {
      product: "report",
      kind: "report",
      object: "report",
      id: "r1",
      title: "x",
    });
    expect(status).toBe(404);
  });
});

describe("administrator control", () => {
  test("switched off, the assistant does nothing", async () => {
    const offApp = startFakeApp({ chatEnabled: false });
    const off = createAssistant({
      config: { ...config, appApiUrl: `http://127.0.0.1:${offApp.port}` },
      audit: new MemoryAuditLog(),
      tickets: new TicketService(new MemoryTicketStore(), 60),
    });
    const call = (path: string, init: RequestInit = {}) =>
      off(
        new Request(`http://localhost/chat${path}`, {
          ...init,
          headers: { cookie: "crm_app.session_token=tok-admin", "content-type": "application/json" },
        })
      );
    const session = (await (await call("/api/session")).json()) as any;
    expect(session.enabled).toBe(false);
    const ticket = await call("/api/tickets", {
      method: "POST",
      body: JSON.stringify({ product: "app", kind: "page", object: "bus_account", title: "x" }),
    });
    expect(ticket.status).toBe(403);
    expect((await call("/api/copilotkit/info")).status).toBe(403);
    offApp.stop(true);
  });

  test("the switches are relayed without a session, and say nothing else", async () => {
    await as("tok-agent", "/api/session");
    const response = await as(null, "/switches");
    expect(await response.json()).toEqual({ enabled: true, chatOnly: false });
  });

  test("the audit trail is the administrator's", async () => {
    expect((await as("tok-agent", "/api/audit")).status).toBe(403);
    expect((await as("tok-admin", "/api/audit")).status).toBe(200);
  });
});

describe("the conversation", () => {
  test("a question runs tools as the person and ends with an intent, not an address", async () => {
    const response = await as("tok-agent", "/api/copilotkit/agent/default/run", {
      method: "POST",
      body: JSON.stringify({
        threadId: "thread-1",
        runId: "run-1",
        messages: [{ id: "m1", role: "user", content: "open the Acme account" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      }),
    });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain("search_records");
    expect(stream).toContain("Acme Corporation");
    expect(stream).toContain("I opened Acme Corporation.");
    // Nothing the model or the browser receives names a page.
    expect(stream).not.toContain("/app/");
    expect(stream).not.toContain("embed=1");

    const entries = await audit.recent(10);
    expect(entries.map((entry) => entry.tool)).toEqual(expect.arrayContaining(["search_records", "open_record"]));
    expect(entries.every((entry) => entry.user === "support.agent@crm.example.com")).toBe(true);

    // The model was told what it may call, and was given no path either.
    const sent = JSON.stringify(model.requests);
    expect(sent).toContain("open_record");
    expect(sent).not.toContain("/app/");
  });

  test("another person cannot read that conversation", async () => {
    const response = await as("tok-sales", "/api/copilotkit/agent/default/connect", {
      method: "POST",
      body: JSON.stringify({
        threadId: "thread-1",
        runId: "run-2",
        messages: [],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      }),
    });
    const text = await response.text();
    expect(text).not.toContain("Acme Corporation");
  });
});
