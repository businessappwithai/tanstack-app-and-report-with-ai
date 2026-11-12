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
