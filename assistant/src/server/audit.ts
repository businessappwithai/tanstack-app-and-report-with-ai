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

  constructor(
    private readonly pool: pg.Pool,
    private readonly createDatabase: () => Promise<void> = async () => undefined
  ) {}

  /** Idempotent, and retried on the next call when the database is not up yet. */
  private ensure(): Promise<void> {
    this.ready ??= this.createDatabase()
      .then(() =>
        this.pool.query(
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

/**
 * Create the assistant's database when the server does not have it yet.
 *
 * The orchestrator's init script creates it on a fresh volume, but an init
 * script never runs again — so a deployment that predates the assistant has a
 * server without it, and the first audit write would fail for good.
 */
export async function ensureDatabase(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  const name = url.pathname.replace(/^\//, "");
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Refusing to create a database called "${name}"`);
  url.pathname = "/postgres";
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (found.rowCount === 0) await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
}

export function createAuditLog(databaseUrl: string | null): AuditLog {
  if (!databaseUrl) return new MemoryAuditLog();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  // Without a listener, the server dropping an idle connection ends the process.
  pool.on("error", () => undefined);
  return new PostgresAuditLog(pool, () => ensureDatabase(databaseUrl));
}
