/**
 * The administrator's two switches, as the assistant last read them.
 *
 * The switches live in the generated application (`CHAT_ENABLED`,
 * `CHAT_ONLY_MODE`), and reading them needs somebody's session. The reporting
 * platform has no such session when it decides whether a page load must come
 * through the chat, so it asks the assistant, which relays its last reading at
 * `/chat/switches`.
 *
 * Two things that reading must not do:
 *
 *  - pass "I do not know yet" off as "off". A freshly started assistant has
 *    read nothing; answering `chatOnly: false` then would lift the
 *    administrator's lock on the reporting platform after every restart. The
 *    relay answers 503 until it knows, and the platform keeps its own last
 *    answer;
 *  - forget across a restart. The last reading is kept in the assistant's
 *    database, so a restart comes back knowing what it knew.
 */
import type { AssistantDatabase } from "./database";

export interface Switches {
  enabled: boolean;
  chatOnly: boolean;
}

export interface SwitchStore {
  load(): Promise<Switches | null>;
  save(switches: Switches): Promise<void>;
}

export class MemorySwitchStore implements SwitchStore {
  private value: Switches | null = null;

  async load(): Promise<Switches | null> {
    return this.value;
  }

  async save(switches: Switches): Promise<void> {
    this.value = { ...switches };
  }
}

const STATE_DDL = `CREATE TABLE IF NOT EXISTS chat_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

export class PostgresSwitchStore implements SwitchStore {
  private readonly ensure: () => Promise<void>;

  constructor(private readonly database: AssistantDatabase) {
    this.ensure = database.prepared(STATE_DDL);
  }

  async load(): Promise<Switches | null> {
    await this.ensure();
    const result = await this.database.pool.query("SELECT value FROM chat_state WHERE key = 'switches'");
    const value = result.rows[0]?.value;
    if (!value || typeof value.enabled !== "boolean" || typeof value.chatOnly !== "boolean") return null;
    return { enabled: value.enabled, chatOnly: value.chatOnly };
  }

  async save(switches: Switches): Promise<void> {
    await this.ensure();
    await this.database.pool.query(
      `INSERT INTO chat_state (key, value) VALUES ('switches', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(switches)]
    );
  }
}

export function createSwitchStore(database: AssistantDatabase | null): SwitchStore {
  return database ? new PostgresSwitchStore(database) : new MemorySwitchStore();
}
