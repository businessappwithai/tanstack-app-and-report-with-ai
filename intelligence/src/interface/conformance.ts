/**
 * What every Intelligence provider must do, as one suite each provider runs against itself.
 *
 * The in-memory provider runs it in `providers/memory/__tests__`; the Buzz provider runs it against a
 * real relay in `providers/buzz/__tests__`. A provider that passes here can stand under the runner
 * and the OpenBot routes without either of them knowing which one it is.
 */
import { describe, expect, test } from "bun:test";
import type { Intelligence, RecordedRun, ThreadChange } from "./types";
import { ThreadExistsError } from "./types";

export interface ConformanceOptions {
  /** A fresh provider. Called once per test, so state never leaks between tests. */
  make: () => Promise<Intelligence> | Intelligence;
  /** Two people who are different owners to this provider. */
  alice?: string;
  bob?: string;
}

const run = (runId: string, text: string, prior: RecordedRun["messages"] = []): RecordedRun => ({
  runId,
  agentId: "default",
  parentRunId: null,
  createdAt: Date.now(),
  events: [
    { type: "RUN_STARTED", threadId: "t", runId },
    { type: "TEXT_MESSAGE_START", messageId: `${runId}-m`, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: `${runId}-m`, delta: text },
    { type: "TEXT_MESSAGE_END", messageId: `${runId}-m` },
    { type: "RUN_FINISHED", threadId: "t", runId },
  ],
  messages: [...prior, { id: `${runId}-u`, role: "user", content: `ask ${runId}` }, { id: `${runId}-m`, role: "assistant", content: text }],
});

export function describeIntelligence(name: string, options: ConformanceOptions): void {
  const alice = options.alice ?? "alice@example.org";
  const bob = options.bob ?? "bob@example.org";
  const id = () => `thread-${crypto.randomUUID()}`;

  describe(`${name}: threads`, () => {
    test("a created thread belongs to its owner and nobody else", async () => {
      const intelligence = await options.make();
      const threadId = id();
      const created = await intelligence.threads.create(alice, { threadId, agentId: "default", name: "Acme" });
      expect(created).toMatchObject({ id: threadId, name: "Acme", agentId: "default", archived: false, pinned: false, lastRunAt: null, lastMessage: null });
      expect((await intelligence.threads.get(alice, threadId))?.id).toBe(threadId);
      expect(await intelligence.threads.get(bob, threadId)).toBeNull();
      expect((await intelligence.threads.list(alice)).map((t) => t.id)).toContain(threadId);
      expect((await intelligence.threads.list(bob)).map((t) => t.id)).not.toContain(threadId);
    });

    test("the owner's email is not case-sensitive", async () => {
      const intelligence = await options.make();
      const threadId = id();
      await intelligence.threads.create(alice.toUpperCase(), { threadId, agentId: "default" });
      expect((await intelligence.threads.get(alice, threadId))?.id).toBe(threadId);
    });

    test("a thread id cannot be created twice, even by someone else", async () => {
      const intelligence = await options.make();
      const threadId = id();
      await intelligence.threads.create(alice, { threadId, agentId: "default" });
      await expect(intelligence.threads.create(alice, { threadId, agentId: "default" })).rejects.toBeInstanceOf(ThreadExistsError);
      await expect(intelligence.threads.create(bob, { threadId, agentId: "default" })).rejects.toBeInstanceOf(ThreadExistsError);
      expect(await intelligence.threads.get(bob, threadId)).toBeNull();
    });

    test("rename and archive change the thread for its owner only", async () => {
      const intelligence = await options.make();
      const threadId = id();
      await intelligence.threads.create(alice, { threadId, agentId: "default" });
      expect(await intelligence.threads.update(bob, threadId, { name: "Taken" })).toBeNull();
      expect((await intelligence.threads.update(alice, threadId, { name: "Renamed" }))?.name).toBe("Renamed");
      await intelligence.threads.update(alice, threadId, { archived: true });
      expect((await intelligence.threads.list(alice)).map((t) => t.id)).not.toContain(threadId);
      const archived = await intelligence.threads.list(alice, { includeArchived: true });
      expect(archived.find((t) => t.id === threadId)).toMatchObject({ name: "Renamed", archived: true });
    });

    test("pin and the newest message are kept, and order the owner's list", async () => {
      const intelligence = await options.make();
      const older = id();
      const newer = id();
      await intelligence.threads.create(alice, { threadId: older, agentId: "default" });
      await intelligence.threads.create(alice, { threadId: newer, agentId: "default" });
      const pinned = await intelligence.threads.update(alice, older, { pinned: true });
      expect(pinned?.pinned).toBe(true);
      await intelligence.threads.update(alice, older, { lastMessage: { text: "first", at: "2026-11-18T10:00:00.000Z", by: "person" } });
      const latest = await intelligence.threads.update(alice, newer, {
        lastMessage: { text: "Here is Acme.", at: "2026-11-18T11:00:00.000Z", by: { agentId: "default" } },
      });
      expect(latest?.lastMessage).toEqual({ text: "Here is Acme.", at: "2026-11-18T11:00:00.000Z", by: { agentId: "default" } });
      const listed = await intelligence.threads.list(alice);
      expect(listed.map((t) => t.id).filter((t) => t === older || t === newer)).toEqual([newer, older]);
      expect(listed.find((t) => t.id === older)).toMatchObject({ pinned: true, lastMessage: { text: "first", by: "person" } });
    });

    test("delete removes the thread for its owner, and is refused for anyone else", async () => {
      const intelligence = await options.make();
      const threadId = id();
      await intelligence.threads.create(alice, { threadId, agentId: "default" });
      expect(await intelligence.threads.delete(bob, threadId)).toBe(false);
      expect(await intelligence.threads.get(alice, threadId)).not.toBeNull();
      expect(await intelligence.threads.delete(alice, threadId)).toBe(true);
      expect(await intelligence.threads.get(alice, threadId)).toBeNull();
    });

    test("a change to a thread reaches its owner's listeners and no one else's", async () => {
      const intelligence = await options.make();
      const seen: ThreadChange[] = [];
      const others: ThreadChange[] = [];
      const stop = intelligence.changes.subscribe(alice, (change) => seen.push(change));
      intelligence.changes.subscribe(bob, (change) => others.push(change));
      const threadId = id();
      await intelligence.threads.create(alice, { threadId, agentId: "default" });
      await intelligence.threads.update(alice, threadId, { name: "Named" });
      await intelligence.threads.delete(alice, threadId);
      stop();
      expect(seen.map((c) => c.operation)).toEqual(["created", "updated", "deleted"]);
      expect(others).toEqual([]);
    });
  });

  describe(`${name}: runs`, () => {
    test("recorded runs come back in order, with the latest snapshot as the thread's messages", async () => {
      const intelligence = await options.make();
      const threadId = id();
      await intelligence.threads.create(alice, { threadId, agentId: "default" });
      const first = run("r1", "first answer");
      const second = run("r2", "second answer", first.messages);
      await intelligence.runs.record(alice, threadId, first);
      await intelligence.runs.record(alice, threadId, second);
      const runs = await intelligence.runs.list(alice, threadId);
      expect(runs.map((r) => r.runId)).toEqual(["r1", "r2"]);
      expect(runs[1]!.events).toEqual(second.events);
      expect((await intelligence.threads.messages(alice, threadId)).map((m) => m.id)).toEqual(["r1-u", "r1-m", "r2-u", "r2-m"]);
      expect((await intelligence.threads.get(alice, threadId))?.lastRunAt).not.toBeNull();
    });

    test("recording the same run twice keeps one copy", async () => {
      const intelligence = await options.make();
      const threadId = id();
      await intelligence.threads.create(alice, { threadId, agentId: "default" });
      await intelligence.runs.record(alice, threadId, run("r1", "once"));
      await intelligence.runs.record(alice, threadId, run("r1", "once"));
      expect((await intelligence.runs.list(alice, threadId)).length).toBe(1);
    });

    test("another person can neither read nor record runs on the thread", async () => {
      const intelligence = await options.make();
      const threadId = id();
      await intelligence.threads.create(alice, { threadId, agentId: "default" });
      await intelligence.runs.record(alice, threadId, run("r1", "private"));
      expect(await intelligence.runs.list(bob, threadId)).toEqual([]);
      expect(await intelligence.threads.messages(bob, threadId)).toEqual([]);
      await intelligence.runs.record(bob, threadId, run("rb", "intrusion"));
      expect((await intelligence.runs.list(alice, threadId)).map((r) => r.runId)).toEqual(["r1"]);
    });
  });

  describe(`${name}: memory`, () => {
    test("create, list, recall, supersede and forget", async () => {
      const intelligence = await options.make();
      const weekly = await intelligence.memory.create(alice, { content: "Prefers a weekly summary on Mondays", kind: "topical", sourceThreadIds: ["t1"] });
      await intelligence.memory.create(alice, { content: "Works in the Lisbon office", kind: "topical" });
      expect(weekly).toMatchObject({ kind: "topical", scope: "user", sourceThreadIds: ["t1"], invalidatedAt: null });
      expect((await intelligence.memory.list(alice)).length).toBe(2);

      const recalled = await intelligence.memory.recall(alice, { query: "weekly summary" });
      expect(recalled[0]?.id).toBe(weekly.id);
      expect(recalled[0]!.score).toBeGreaterThan(0);
      expect(recalled.some((m) => m.content.includes("Lisbon"))).toBe(false);

      const replaced = await intelligence.memory.supersede(alice, weekly.id, { content: "Prefers a daily summary", kind: "topical" });
      expect(replaced?.content).toBe("Prefers a daily summary");
      const live = await intelligence.memory.list(alice);
      expect(live.map((m) => m.id)).not.toContain(weekly.id);
      expect((await intelligence.memory.list(alice, { includeInvalidated: true })).find((m) => m.id === weekly.id)?.invalidatedAt).not.toBeNull();

      expect(await intelligence.memory.forget(alice, replaced!.id)).toBe(true);
      expect(await intelligence.memory.forget(alice, replaced!.id)).toBe(false);
      expect((await intelligence.memory.list(alice)).map((m) => m.content)).toEqual(["Works in the Lisbon office"]);
    });

    test("one person's memories are invisible and untouchable to another", async () => {
      const intelligence = await options.make();
      const secret = await intelligence.memory.create(alice, { content: "Salary review in March", kind: "episodic" });
      expect(await intelligence.memory.list(bob)).toEqual([]);
      expect(await intelligence.memory.recall(bob, { query: "salary" })).toEqual([]);
      expect(await intelligence.memory.supersede(bob, secret.id, { content: "changed", kind: "episodic" })).toBeNull();
      expect(await intelligence.memory.forget(bob, secret.id)).toBe(false);
      expect((await intelligence.memory.list(alice))[0]?.content).toBe("Salary review in March");
    });
  });
}
