/**
 * The Intelligence interface: what CopilotKit Intelligence does, as an open contract.
 *
 * Durable, owner-scoped threads, the runs recorded on them, and a person's memory. Field names follow
 * Intelligence's public client contract (`ThreadSummary`, `MemorySummary` in `@copilotkit/runtime`'s
 * `intelligence-platform/client`), so the same shapes can be served on the wire later without
 * translation.
 *
 * Every method that names an `owner` acts as that owner and nobody else: a thread or memory
 * belonging to someone else is answered as absent, never as forbidden, so a caller cannot learn
 * that it exists. `owner` is the application person's email, lower-cased, as `identifyUser`
 * returns it.
 *
 * What is not here, on purpose: the live state of a run in progress (who is running, the event
 * stream being produced, stop). That stays in the runner's process, as CopilotKit's own in-memory
 * runner keeps it, and is only recorded here once the run has finished.
 */

/** One AG-UI event, as the runtime emits it. Opaque here beyond its `type`. */
export interface AgUiEvent {
  type: string;
  [field: string]: unknown;
}

/** One AG-UI message, as the runtime stores it in a thread's snapshot. */
export interface ThreadMessage {
  id: string;
  role: string;
  content?: unknown;
  [field: string]: unknown;
}

export interface ThreadSummary {
  id: string;
  name: string | null;
  agentId: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
}

/** A finished run, as the runner records it: its compacted events and the thread's messages after it. */
export interface RecordedRun {
  runId: string;
  agentId: string;
  parentRunId: string | null;
  events: AgUiEvent[];
  /** The thread's whole message snapshot at the end of this run. */
  messages: ThreadMessage[];
  createdAt: number;
}

export type ThreadChange =
  | { operation: "created" | "updated" | "archived"; thread: ThreadSummary }
  | { operation: "deleted"; threadId: string };

export type MemoryKind = "topical" | "episodic" | "operational";
export type MemoryScope = "user" | "project";

export interface MemorySummary {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  content: string;
  sourceThreadIds: string[];
  /** When the memory was forgotten or superseded; null while it is live. */
  invalidatedAt: string | null;
  createdAt: string;
}

export interface MemoryInput {
  content: string;
  kind: MemoryKind;
  scope?: MemoryScope;
  sourceThreadIds?: string[];
}

export interface ThreadStore {
  list(owner: string, options?: { agentId?: string; includeArchived?: boolean; limit?: number }): Promise<ThreadSummary[]>;
  /** Fails with `ThreadExistsError` when the id is taken, whoever holds it. */
  create(owner: string, input: { threadId: string; agentId: string; name?: string | null }): Promise<ThreadSummary>;
  get(owner: string, threadId: string): Promise<ThreadSummary | null>;
  update(owner: string, threadId: string, changes: { name?: string | null; archived?: boolean }): Promise<ThreadSummary | null>;
  /** True when it was there to delete. */
  delete(owner: string, threadId: string): Promise<boolean>;
  /** The message snapshot after the latest run; empty for a thread with none, or not theirs. */
  messages(owner: string, threadId: string): Promise<ThreadMessage[]>;
}

export interface RunStore {
  /** Record a finished run on a thread the owner holds. Recording the same run id twice keeps one. */
  record(owner: string, threadId: string, run: RecordedRun): Promise<void>;
  /** Every recorded run on the thread, oldest first; empty for a thread that is not theirs. */
  list(owner: string, threadId: string): Promise<RecordedRun[]>;
}

export interface MemoryStore {
  list(owner: string, options?: { includeInvalidated?: boolean }): Promise<MemorySummary[]>;
  create(owner: string, input: MemoryInput): Promise<MemorySummary>;
  /** Replace a live memory with a new one; the old one is invalidated. Null when it is not a live memory of theirs. */
  supersede(owner: string, id: string, input: MemoryInput): Promise<MemorySummary | null>;
  /** True when a live memory of theirs was forgotten. */
  forget(owner: string, id: string): Promise<boolean>;
  recall(owner: string, query: { query: string; limit?: number; scope?: MemoryScope }): Promise<Array<MemorySummary & { score: number }>>;
}

export interface ThreadChanges {
  /** Listen for changes to the owner's threads. Returns the function that stops listening. */
  subscribe(owner: string, listener: (change: ThreadChange) => void): () => void;
}

export interface Intelligence {
  threads: ThreadStore;
  runs: RunStore;
  memory: MemoryStore;
  changes: ThreadChanges;
}

export class ThreadExistsError extends Error {
  readonly code = "THREAD_EXISTS";
  constructor(threadId: string) {
    super(`Thread ${threadId} already exists`);
  }
}
