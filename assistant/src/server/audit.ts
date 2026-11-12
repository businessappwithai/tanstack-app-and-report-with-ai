/**
 * The audit trail: every tool the assistant ran for someone, and how it ended.
 *
 * It records the tool, the target and the outcome — never a record's contents
 * and never a search's results. With `CHAT_DATABASE_URL` it is a table in the
 * assistant's own database; without, it is a bounded list in memory, which is
 * what development and the tests use.
 */
import pg from "pg";

export interface AuditEntry {
  at: string;
  user: string;
  tool: string;
  target: string;
  outcome: "ok" | "refused" | "error";
}

export interface AuditLog {
  record(entry: Omit<AuditEntry, "at">): Promise<void>;
  recent(limit: number): Promise<AuditEntry[]>;
}

export class MemoryAuditLog implements AuditLog {
  private readonly entries: AuditEntry[] = [];

  async record(entry: Omit<AuditEntry, "at">): Promise<void> {
    this.entries.unshift({ at: new Date().toISOString(), ...entry });
    if (this.entries.length > 1000) this.entries.length = 1000;
  }

  async recent(limit: number): Promise<AuditEntry[]> {
    return this.entries.slice(0, limit);
  }
}

export class PostgresAuditLog implements AuditLog {
  private ready: Promise<void> | null = null;

  constructor(private readonly pool: pg.Pool) {}

  /** Idempotent, and retried on the next call when the database is not up yet. */
  private ensure(): Promise<void> {
    this.ready ??= this.pool
      .query(
        `CREATE TABLE IF NOT EXISTS chat_audit (
           id BIGSERIAL PRIMARY KEY,
           at TIMESTAMPTZ NOT NULL DEFAULT now(),
           user_email TEXT NOT NULL,
           tool TEXT NOT NULL,
           target TEXT NOT NULL,
           outcome TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS chat_audit_at ON chat_audit (at DESC);`
      )
      .then(() => undefined)
      .catch((error) => {
        this.ready = null;
        throw error;
      });
    return this.ready;
  }

  async record(entry: Omit<AuditEntry, "at">): Promise<void> {
    await this.ensure();
    await this.pool.query(
      "INSERT INTO chat_audit (user_email, tool, target, outcome) VALUES ($1, $2, $3, $4)",
      [entry.user, entry.tool, entry.target, entry.outcome]
    );
  }

  async recent(limit: number): Promise<AuditEntry[]> {
    await this.ensure();
    const result = await this.pool.query(
      "SELECT at, user_email, tool, target, outcome FROM chat_audit ORDER BY at DESC LIMIT $1",
      [limit]
    );
    return result.rows.map((row) => ({
      at: new Date(row.at).toISOString(),
      user: row.user_email,
      tool: row.tool,
      target: row.target,
      outcome: row.outcome,
    }));
  }
}

export function createAuditLog(databaseUrl: string | null): AuditLog {
  if (!databaseUrl) return new MemoryAuditLog();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  // Without a listener, the server dropping an idle connection ends the process.
  pool.on("error", () => undefined);
  return new PostgresAuditLog(pool);
}
