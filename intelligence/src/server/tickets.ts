/**
 * Tickets: what the chat holds instead of an address.
 *
 * An "open" tool proves the person may read the target, then stores a ticket.
 * The chat frame loads `/chat/open/<ticket>`; redeeming it gives the real
 * address to the redirect and to nothing else. A ticket is 256 random bits,
 * works once, lasts a minute, and is bound to the person it was issued to.
 *
 * Redeeming must be one step — find, check and spend together — or two frames
 * racing on one ticket both get in.
 */
import type { AssistantDatabase } from "./database";
import { randomToken } from "./signing";

export type TargetProduct = "app" | "report";

/** What to open, in the model's terms. This is what conversation history stores. */
export interface Intent {
  product: TargetProduct;
  /** e.g. "record", "page", "report", "dashboard", "chart". */
  kind: string;
  /** The page or entity key from the registry. */
  object: string;
  /** A record or definition id, when the intent is about one thing. */
  id?: string;
  title: string;
}

export interface Ticket {
  token: string;
  /** The person's e-mail address, lower-cased. */
  user: string;
  intent: Intent;
  /** The resolved path inside the product. Never leaves the server. */
  path: string;
  expiresAt: number;
}

export interface TicketStore {
  put(ticket: Ticket): Promise<void>;
  /** Remove and return the ticket if it exists; null otherwise. Atomic. */
  take(token: string): Promise<Ticket | null>;
  sweep(now: number): Promise<void>;
}

export class MemoryTicketStore implements TicketStore {
  private readonly tickets = new Map<string, Ticket>();

  async put(ticket: Ticket): Promise<void> {
    this.tickets.set(ticket.token, ticket);
  }

  async take(token: string): Promise<Ticket | null> {
    const ticket = this.tickets.get(token) ?? null;
    if (ticket) this.tickets.delete(token);
    return ticket;
  }

  async sweep(now: number): Promise<void> {
    for (const [token, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(token);
    }
  }
}

const TICKET_DDL = `CREATE TABLE IF NOT EXISTS chat_tickets (
  token_hash TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  intent JSONB NOT NULL,
  path TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_tickets_expires ON chat_tickets (expires_at);`;

/** Tickets that survive a restart and work across replicas. Only a hash of the token is stored. */
export class PostgresTicketStore implements TicketStore {
  private readonly ensure: () => Promise<void>;

  constructor(private readonly database: AssistantDatabase) {
    this.ensure = database.prepared(TICKET_DDL);
  }

  private hash(token: string): string {
    return new Bun.CryptoHasher("sha256").update(token).digest("hex");
  }

  async put(ticket: Ticket): Promise<void> {
    await this.ensure();
    await this.database.pool.query(
      "INSERT INTO chat_tickets (token_hash, user_email, intent, path, expires_at) VALUES ($1, $2, $3, $4, to_timestamp($5))",
      [this.hash(ticket.token), ticket.user, JSON.stringify(ticket.intent), ticket.path, ticket.expiresAt / 1000]
    );
  }

  /** One DELETE … RETURNING: find and spend are the same statement, so two frames cannot both win. */
  async take(token: string): Promise<Ticket | null> {
    await this.ensure();
    const result = await this.database.pool.query(
      "DELETE FROM chat_tickets WHERE token_hash = $1 RETURNING user_email, intent, path, extract(epoch FROM expires_at) * 1000 AS expires_ms",
      [this.hash(token)]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      token,
      user: row.user_email,
      intent: row.intent,
      path: row.path,
      expiresAt: Math.round(Number(row.expires_ms)),
    };
  }

  async sweep(now: number): Promise<void> {
    await this.ensure();
    await this.database.pool.query("DELETE FROM chat_tickets WHERE expires_at <= to_timestamp($1)", [now / 1000]);
  }
}

export type RedeemResult =
  | { ok: true; ticket: Ticket }
  /** One answer for unknown, spent, expired and somebody else's: the caller learns nothing. */
  | { ok: false };

export class TicketService {
  constructor(
    private readonly store: TicketStore,
    private readonly ttlSeconds: number,
    private readonly clock: () => number = Date.now
  ) {}

  async issue(user: string, intent: Intent, path: string): Promise<string> {
    const token = randomToken(32);
    await this.store.put({
      token,
      user: user.toLowerCase(),
      intent,
      path,
      expiresAt: this.clock() + this.ttlSeconds * 1000,
    });
    return token;
  }

  async redeem(token: string, user: string | null): Promise<RedeemResult> {
    // Spend first: a ticket presented by the wrong person, or late, is burnt too.
    const ticket = await this.store.take(token);
    if (!ticket) return { ok: false };
    if (ticket.expiresAt <= this.clock()) return { ok: false };
    if (!user || ticket.user !== user.toLowerCase()) return { ok: false };
    return { ok: true, ticket };
  }
}
