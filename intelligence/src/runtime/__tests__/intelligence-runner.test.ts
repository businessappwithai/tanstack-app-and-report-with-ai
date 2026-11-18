/**
 * The Intelligence runner, driven through the assistant's real HTTP surface and a scripted model,
 * over the in-memory provider. The Buzz provider passes the same interface suite, so what holds here
 * holds on the relay.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createMemoryIntelligence } from "../../providers/memory";
import { createAssistant } from "../../server/app";
import { MemoryAuditLog } from "../../server/audit";
import { loadConfig } from "../../server/config";
import { SECRET, startFakeApp, startFakeModel, startFakeReport } from "../../server/__tests__/fakes";
import { MemoryTicketStore, TicketService } from "../../server/tickets";
import type { Intelligence } from "../../interface/types";
import { IntelligenceRunner } from "../intelligence-runner";

const app = startFakeApp();
const report = startFakeReport();
const model = startFakeModel([{ text: "Remembered: the quarterly review is on Friday." }]);
afterAll(() => {
  app.stop(true);
  report.server.stop(true);
  model.server.stop(true);
});

const config = loadConfig({
  CHAT_BRIDGE_SECRET: SECRET,
  APP_API_URL: `http://127.0.0.1:${app.port}`,
  REPORT_URL: `http://127.0.0.1:${report.server.port}`,
  AI_BASE_URL: `http://127.0.0.1:${model.server.port}/v1`,
  AI_MODEL: "fake",
  PUBLIC_ORIGIN: "http://localhost",
});

function start(intelligence: Intelligence) {
  const runner = new IntelligenceRunner(intelligence, { retryDelaysMs: [] });
  const handle = createAssistant({
    config,
    audit: new MemoryAuditLog(),
    intelligence,
    runner,
    tickets: new TicketService(new MemoryTicketStore(), 60),
  });
  return { handle, runner };
}

const body = (threadId: string, messages: unknown[] = []) =>
  JSON.stringify({ threadId, runId: `run-${crypto.randomUUID()}`, messages, tools: [], context: [], state: {}, forwardedProps: {} });

const post = (handle: (request: Request) => Promise<Response>, token: string, path: string, payload: string) =>
  handle(
    new Request(`http://localhost/chat/api/copilotkit${path}`, {
      method: "POST",
      body: payload,
      headers: { cookie: `crm_app.session_token=${token}`, "content-type": "application/json" },
    })
  );

const ask = (threadId: string) => body(threadId, [{ id: `m-${crypto.randomUUID()}`, role: "user", content: "when is the review?" }]);

describe("the Intelligence runner", () => {
  test("a finished run is recorded on the owner's thread, with the agent's messages", async () => {
    const intelligence = createMemoryIntelligence();
    const { handle, runner } = start(intelligence);
    const ran = await post(handle, "tok-agent", "/agent/default/run", ask("t-record"));
    expect(ran.status).toBe(200);
    expect(await ran.text()).toContain("quarterly review");
    await runner.settle();

    const owner = "support.agent@crm.example.com";
    expect((await intelligence.threads.get(owner, "t-record"))?.agentId).toBe("default");
    const runs = await intelligence.runs.list(owner, "t-record");
    expect(runs.length).toBe(1);
    expect(runs[0]!.events.some((e) => e.type === "RUN_FINISHED")).toBe(true);
    expect(JSON.stringify(await intelligence.threads.messages(owner, "t-record"))).toContain("quarterly review");
  });

  test("conversations survive a restart, for their owner only", async () => {
    const intelligence = createMemoryIntelligence();
    const first = start(intelligence);
    await (await post(first.handle, "tok-agent", "/agent/default/run", ask("t-restart"))).text();
    await first.runner.settle();

    // A new process: no run in memory, everything comes from the provider.
    const second = start(intelligence);
    const owner = await (await post(second.handle, "tok-agent", "/agent/default/connect", body("t-restart"))).text();
    expect(owner).toContain("quarterly review");

    const other = await (await post(second.handle, "tok-sales", "/agent/default/connect", body("t-restart"))).text();
    expect(other).not.toContain("quarterly review");
  });

  test("nobody can run on someone else's thread, and their attempt changes nothing", async () => {
    const intelligence = createMemoryIntelligence();
    const { handle, runner } = start(intelligence);
    await (await post(handle, "tok-agent", "/agent/default/run", ask("t-owned"))).text();
    await runner.settle();

    const intrusion = await post(handle, "tok-sales", "/agent/default/run", ask("t-owned"));
    const answer = await intrusion.text();
    expect(answer).not.toContain("quarterly review");
    expect(intrusion.status !== 200 || answer.includes("THREAD_ACCESS_DENIED")).toBe(true);
    await runner.settle();
    expect((await intelligence.runs.list("support.agent@crm.example.com", "t-owned")).length).toBe(1);
    expect(await intelligence.threads.get("sales.manager@crm.example.com", "t-owned")).toBeNull();
  });

  test("a second turn sees the first, and its run names the first as parent", async () => {
    const intelligence = createMemoryIntelligence();
    const { handle, runner } = start(intelligence);
    await (await post(handle, "tok-agent", "/agent/default/run", ask("t-turns"))).text();
    await runner.settle();
    await (await post(handle, "tok-agent", "/agent/default/run", ask("t-turns"))).text();
    await runner.settle();
    const runs = await intelligence.runs.list("support.agent@crm.example.com", "t-turns");
    expect(runs.length).toBe(2);
    expect(runs[1]!.parentRunId).toBe(runs[0]!.runId);
  });

  test("a run whose record cannot be written is reported, not lost silently", async () => {
    const intelligence = createMemoryIntelligence();
    const failures: string[] = [];
    const broken: Intelligence = {
      ...intelligence,
      runs: { ...intelligence.runs, record: async () => Promise.reject(new Error("relay unavailable")) },
    };
    const runner = new IntelligenceRunner(broken, { retryDelaysMs: [1, 1], onRecordFailure: (_e, c) => failures.push(c.runId) });
    const handle = createAssistant({ config, audit: new MemoryAuditLog(), intelligence: broken, runner, tickets: new TicketService(new MemoryTicketStore(), 60) });
    await (await post(handle, "tok-agent", "/agent/default/run", ask("t-broken"))).text();
    await runner.settle();
    expect(failures.length).toBe(1);
  });
});
