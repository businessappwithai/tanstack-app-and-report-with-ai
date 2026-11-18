/**
 * The Intelligence interface held in memory: the test double, and the local-development default
 * when no Buzz relay is configured. Nothing survives a restart.
 */
import { ChangeHub } from "../../interface/changes";
import { rankMemories } from "../../interface/recall";
import {
  type Intelligence,
  type MemoryInput,
  type MemoryStore,
  type MemorySummary,
  type RecordedRun,
  type RunStore,
  type ThreadMessage,
  type ThreadStore,
  type ThreadSummary,
  ThreadExistsError,
} from "../../interface/types";

interface HeldThread {
  owner: string;
  summary: ThreadSummary;
  runs: RecordedRun[];
}

const now = () => new Date().toISOString();
const key = (owner: string) => owner.toLowerCase();

export function createMemoryIntelligence(): Intelligence {
  const threads = new Map<string, HeldThread>();
  const memories = new Map<string, { owner: string; memory: MemorySummary }>();
  const changes = new ChangeHub();

  const held = (owner: string, threadId: string) => {
    const thread = threads.get(threadId);
    return thread && thread.owner === key(owner) ? thread : undefined;
  };

  const threadStore: ThreadStore = {
    async list(owner, options = {}) {
      return [...threads.values()]
        .filter((t) => t.owner === key(owner))
        .filter((t) => options.includeArchived || !t.summary.archived)
        .filter((t) => !options.agentId || t.summary.agentId === options.agentId)
        .map((t) => ({ ...t.summary }))
        .sort((a, b) => (b.lastRunAt ?? b.updatedAt).localeCompare(a.lastRunAt ?? a.updatedAt))
        .slice(0, options.limit && options.limit > 0 ? options.limit : undefined);
    },
    async create(owner, input) {
      if (threads.has(input.threadId)) throw new ThreadExistsError(input.threadId);
      const at = now();
      const summary: ThreadSummary = {
        id: input.threadId,
        name: input.name ?? null,
        agentId: input.agentId,
        archived: false,
        createdAt: at,
        updatedAt: at,
        lastRunAt: null,
      };
      threads.set(input.threadId, { owner: key(owner), summary, runs: [] });
      changes.publish(owner, { operation: "created", thread: { ...summary } });
      return { ...summary };
    },
    async get(owner, threadId) {
      const thread = held(owner, threadId);
      return thread ? { ...thread.summary } : null;
    },
    async update(owner, threadId, update) {
      const thread = held(owner, threadId);
      if (!thread) return null;
      if (update.name !== undefined) thread.summary.name = update.name;
      if (update.archived !== undefined) thread.summary.archived = update.archived;
      thread.summary.updatedAt = now();
      const summary = { ...thread.summary };
      changes.publish(owner, { operation: update.archived ? "archived" : "updated", thread: summary });
      return summary;
    },
    async delete(owner, threadId) {
      if (!held(owner, threadId)) return false;
      threads.delete(threadId);
      changes.publish(owner, { operation: "deleted", threadId });
      return true;
    },
    async messages(owner, threadId): Promise<ThreadMessage[]> {
      const thread = held(owner, threadId);
      const last = thread?.runs[thread.runs.length - 1];
      return last ? structuredClone(last.messages) : [];
    },
  };

  const runStore: RunStore = {
    async record(owner, threadId, run) {
      const thread = held(owner, threadId);
      if (!thread) return;
      if (thread.runs.some((r) => r.runId === run.runId)) return;
      thread.runs.push(structuredClone(run));
      thread.summary.lastRunAt = new Date(run.createdAt).toISOString();
      thread.summary.updatedAt = now();
      changes.publish(owner, { operation: "updated", thread: { ...thread.summary } });
    },
    async list(owner, threadId) {
      return structuredClone(held(owner, threadId)?.runs ?? []);
    },
  };

  const live = (owner: string, id: string) => {
    const entry = memories.get(id);
    return entry && entry.owner === key(owner) && entry.memory.invalidatedAt === null ? entry : undefined;
  };
  const make = (input: MemoryInput): MemorySummary => ({
    id: crypto.randomUUID(),
    kind: input.kind,
    scope: input.scope ?? "user",
    content: input.content,
    sourceThreadIds: [...(input.sourceThreadIds ?? [])],
    invalidatedAt: null,
    createdAt: now(),
  });

  const memoryStore: MemoryStore = {
    async list(owner, options = {}) {
      return [...memories.values()]
        .filter((e) => e.owner === key(owner))
        .filter((e) => options.includeInvalidated || e.memory.invalidatedAt === null)
        .map((e) => ({ ...e.memory, sourceThreadIds: [...e.memory.sourceThreadIds] }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async create(owner, input) {
      const memory = make(input);
      memories.set(memory.id, { owner: key(owner), memory });
      return { ...memory };
    },
    async supersede(owner, id, input) {
      const entry = live(owner, id);
      if (!entry) return null;
      entry.memory.invalidatedAt = now();
      const memory = make(input);
      memories.set(memory.id, { owner: key(owner), memory });
      return { ...memory };
    },
    async forget(owner, id) {
      const entry = live(owner, id);
      if (!entry) return false;
      entry.memory.invalidatedAt = now();
      return true;
    },
    async recall(owner, query) {
      return rankMemories(await memoryStore.list(owner), query);
    },
  };

  return { threads: threadStore, runs: runStore, memory: memoryStore, changes };
}
