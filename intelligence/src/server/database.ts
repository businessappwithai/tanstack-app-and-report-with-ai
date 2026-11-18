/**
 * The assistant's own database (`chatdb`): one pool, and tables that create
 * themselves on first use.
 *
 * Nothing here runs at start-up. The compose file gives the assistant no
 * `depends_on` for a database, so the database may not be up yet — or, on a
 * deployment that predates the assistant, may not exist at all. Each store
 * therefore prepares what it needs when it is first asked, and tries again on
 * the next call if that failed.
 */
import pg from "pg";

/**
 * Create the assistant's database when the server does not have it yet.
 *
 * The orchestrator's init script creates it on a fresh volume, but an init
 * script never runs again — so a deployment that predates the assistant has a
 * server without it, and the first write would fail for good.
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

/** A pool on the assistant's database, and a way to make sure that database exists. */
export interface AssistantDatabase {
  pool: pg.Pool;
  /**
   * Returns a function that runs `ddl` once — after creating the database if
   * needed — and remembers that it did. A failure is not remembered, so the
   * next call tries again.
   */
  prepared(ddl: string): () => Promise<void>;
}

export function openDatabase(databaseUrl: string): AssistantDatabase {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  // Without a listener, the server dropping an idle connection ends the process.
  pool.on("error", () => undefined);

  let exists: Promise<void> | null = null;
  const databaseExists = (): Promise<void> => {
    exists ??= ensureDatabase(databaseUrl).catch((error) => {
      exists = null;
      throw error;
    });
    return exists;
  };

  return {
    pool,
    prepared(ddl) {
      let ready: Promise<void> | null = null;
      return () => {
        ready ??= databaseExists()
          .then(() => pool.query(ddl))
          .then(() => undefined)
          .catch((error) => {
            ready = null;
            throw error;
          });
        return ready;
      };
    },
  };
}
