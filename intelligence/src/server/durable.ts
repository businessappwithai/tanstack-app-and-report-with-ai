/**
 * Conversations that survive a restart.
 *
 * CopilotKit's open-source runner keeps threads in a process-wide in-memory
 * store, and its thread endpoints are synchronous, so a database cannot sit
 * underneath it. This runner keeps that store and writes behind it: when a run
 * finishes, the thread — owner, messages and the recorded runs — is saved to
 * `chat_threads`; and before a person's request is served, their saved threads
 * that this process does not hold are loaded back into the store with the
 * runtime's own `appendRun`, so its accounting, run cap and ownership rules
 * apply to them as to any other thread.
 *
 * Ownership is the stored owner, set on the thread's first run. Loading never
 * replaces a thread the process already holds, so a conversation in progress
 * is never overwritten by an older copy.
 */
import { InMemoryAgentRunner, ɵGLOBAL_STORE } from "@copilotkit/runtime/v2";
import { Observable } from "rxjs";
import type { AssistantDatabase } from "./database";

type BaseEvent = ReturnType<InMemoryAgentRunner["run"]> extends Observable<infer E> ? E : never;
type RunRequest = Parameters<InMemoryAgentRunner["run"]>[0];

export interface SavedThread {
  threadId: string;
  owner: string;
  createdAt: number | null;
  messages: unknown[];
  runs: unknown[];
}

/** Where saved threads live. In-memory here for tests; Postgres in the server. */
export interface ThreadStore {
  save(thread: SavedThread): Promise<void>;
  /** Every thread this person owns. */
  forOwner(owner: string): Promise<SavedThread[]>;
}

export class MemoryThreadStore implements ThreadStore {
  readonly threads = new Map<string, SavedThread>();

  async save(thread: SavedThread): Promise<void> {
    // A round trip through JSON, as the database does: what is saved is a copy.
    this.threads.set(thread.threadId, JSON.parse(JSON.stringify(thread)));
  }

  async forOwner(owner: string): Promise<SavedThread[]> {
    return [...this.threads.values()].filter((thread) => thread.owner === owner);
  }
}

const THREAD_DDL = `CREATE TABLE IF NOT EXISTS chat_threads (
  thread_id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  created_at_ms BIGINT,
  messages JSONB NOT NULL,
  runs JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_threads_owner ON chat_threads (owner_email, updated_at DESC);`;

export class PostgresThreadStore implements ThreadStore {
  private readonly ensure: () => Promise<void>;

  constructor(private readonly database: AssistantDatabase) {
    this.ensure = database.prepared(THREAD_DDL);
  }

  async save(thread: SavedThread): Promise<void> {
    await this.ensure();
    // The owner is never rewritten: a thread id that another person already holds is not theirs to take.
    await this.database.pool.query(
      `INSERT INTO chat_threads (thread_id, owner_email, created_at_ms, messages, runs)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (thread_id) DO UPDATE
         SET messages = EXCLUDED.messages, runs = EXCLUDED.runs, updated_at = now()
         WHERE chat_threads.owner_email = EXCLUDED.owner_email`,
      [thread.threadId, thread.owner, thread.createdAt, JSON.stringify(thread.messages), JSON.stringify(thread.runs)]
    );
  }

  async forOwner(owner: string): Promise<SavedThread[]> {
    await this.ensure();
    const result = await this.database.pool.query(
      `SELECT thread_id, owner_email, created_at_ms, messages, runs FROM chat_threads
       WHERE owner_email = $1 ORDER BY updated_at DESC LIMIT 50`,
      [owner]
    );
    return result.rows.map((row) => ({
      threadId: row.thread_id,
      owner: row.owner_email,
      createdAt: row.created_at_ms === null ? null : Number(row.created_at_ms),
      messages: row.messages,
      runs: row.runs,
    }));
  }
}

export class DurableAgentRunner extends InMemoryAgentRunner {
  private readonly loadedAt = new Map<string, number>();
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly threads: ThreadStore,
    /** How long a person's saved threads are trusted to be loaded, so one request does not query each time. */
    private readonly refreshSeconds = 30,
    /** Wait after a run ends for the runtime to record it before it is read back. */
    private readonly settleMs = 25
  ) {
    super();
  }

  /** Load this person's saved threads that the process does not hold. Call before serving them. */
  async restore(owner: string): Promise<void> {
    const key = owner.toLowerCase();
    const last = this.loadedAt.get(key);
    if (last !== undefined && Date.now() - last < this.refreshSeconds * 1000) return;
    const saved = await this.threads.forOwner(key);
    this.loadedAt.set(key, Date.now());
    for (const thread of saved) {
      if (ɵGLOBAL_STORE.peek(thread.threadId)) continue;
      const store = ɵGLOBAL_STORE.getOrCreate(thread.threadId, key);
      const runs = thread.runs as Array<Record<string, any>>;
      runs.forEach((run, index) => {
        ɵGLOBAL_STORE.appendRun(thread.threadId, store, {
          ...(run as any),
          events: run.events as BaseEvent[],
          // The snapshot is a thread-level fact; hand it over with the last run, as the runtime stores it.
          messages: index === runs.length - 1 ? (thread.messages as any[]) : [],
        });
      });
      if (runs.length === 0 && thread.messages.length > 0) store.messagesSnapshot = thread.messages as any[];
      if (store.createdAt === null && thread.createdAt !== null) store.createdAt = thread.createdAt;
    }
  }

  override run(request: RunRequest): Observable<BaseEvent> {
    const source = super.run(request);
    const owner = request.ownerId;
    return new Observable<BaseEvent>((subscriber) => {
      const subscription = source.subscribe({
        next: (event) => subscriber.next(event),
        error: (error) => {
          subscriber.error(error);
          this.persistSoon(request.threadId, owner);
        },
        complete: () => {
          subscriber.complete();
          this.persistSoon(request.threadId, owner);
        },
      });
      return () => subscription.unsubscribe();
    });
  }

  private persistSoon(threadId: string, owner: string | undefined): void {
    setTimeout(() => {
      const store = ɵGLOBAL_STORE.peek(threadId);
      if (!store || !owner || store.ownerId !== owner) return;
      const snapshot: SavedThread = {
        threadId,
        owner: owner.toLowerCase(),
        createdAt: store.createdAt,
        messages: store.messagesSnapshot,
        runs: store.historicRuns,
      };
      // One write at a time, in order; a failed write must not stop the next.
      this.writing = this.writing.then(() => this.threads.save(snapshot)).catch(() => undefined);
    }, this.settleMs).unref?.();
  }

  /** Resolves when every write started so far has finished. For tests and shutdown. */
  async flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.settleMs + 10));
    await this.writing;
  }
}
