import { afterAll, describe, expect, test } from "bun:test";
import { ɵGLOBAL_STORE } from "@copilotkit/runtime/v2";
import { createAssistant } from "../app";
import { MemoryAuditLog } from "../audit";
import { loadConfig } from "../config";
import { DurableAgentRunner, MemoryThreadStore } from "../durable";
import { MemoryTicketStore, TicketService } from "../tickets";
import { SECRET, startFakeApp, startFakeModel, startFakeReport } from "./fakes";

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

const start = (threads: MemoryThreadStore) =>
  createAssistant({
    config,
    audit: new MemoryAuditLog(),
    threads,
    tickets: new TicketService(new MemoryTicketStore(), 60),
  });

const body = (messages: unknown[] = []) =>
  JSON.stringify({ threadId: "durable-1", runId: `run-${Math.random()}`, messages, tools: [], context: [], state: {}, forwardedProps: {} });

const post = (handle: ReturnType<typeof start>, token: string, path: string, payload: string) =>
  handle(
    new Request(`http://localhost/chat/api/copilotkit${path}`, {
      method: "POST",
      body: payload,
      headers: { cookie: `crm_app.session_token=${token}`, "content-type": "application/json" },
    })
  );

describe("conversations survive a restart", () => {
  test("saved after a run, restored for their owner only", async () => {
    const threads = new MemoryThreadStore();
    const first = start(threads);
    const ran = await post(first, "tok-agent", "/agent/default/run", body([{ id: "m1", role: "user", content: "when is the review?" }]));
    expect(ran.status).toBe(200);
    expect(await ran.text()).toContain("quarterly review");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(threads.threads.get("durable-1")?.owner).toBe("support.agent@crm.example.com");

    // A restart: the process holds nothing, the database holds the thread.
    ɵGLOBAL_STORE.clear();
    expect(ɵGLOBAL_STORE.peek("durable-1")).toBeUndefined();

    const second = start(threads);
    const owner = await (await post(second, "tok-agent", "/agent/default/connect", body())).text();
    expect(owner).toContain("quarterly review");

    // Somebody else asking for the same thread id gets nothing of it.
    const other = await (await post(second, "tok-sales", "/agent/default/connect", body())).text();
    expect(other).not.toContain("quarterly review");
  });

  test("restoring never replaces a conversation the process already holds", async () => {
    const threads = new MemoryThreadStore();
    const runner = new DurableAgentRunner(threads, 0);
    await threads.save({ threadId: "live-1", owner: "a@b.c", createdAt: 1, messages: [{ id: "old", role: "user", content: "stale" }], runs: [] });
    const live = ɵGLOBAL_STORE.getOrCreate("live-1", "a@b.c");
    live.messagesSnapshot = [{ id: "new", role: "user", content: "fresh" }] as never;
    await runner.restore("a@b.c");
    expect(JSON.stringify(ɵGLOBAL_STORE.peek("live-1")?.messagesSnapshot)).toContain("fresh");
  });
});
