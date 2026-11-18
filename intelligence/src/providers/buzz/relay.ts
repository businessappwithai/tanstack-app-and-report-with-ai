/**
 * A Buzz relay over its HTTP bridge: `POST /events` to publish a signed event, `POST /query` to read
 * with NIP-01 filters. Every request carries NIP-98 auth signed by the key it acts as, so the relay's
 * own membership checks decide what each person may read: a filter over a channel someone is not in
 * comes back empty, whoever asks.
 *
 * The relay binds a request to its community from the Host it was addressed to, so `baseUrl` must
 * be the address the relay's `RELAY_URL` names (in compose, `http://buzz-relay:3000`).
 */
import { createHash, randomUUID } from "node:crypto";
import { type Event, finalizeEvent } from "nostr-tools/pure";

/**
 * A NIP-98 HTTP auth header for one request. It carries a random `nonce`: without one, two identical
 * requests by the same key within a second sign byte-identical auth events, and the relay rightly
 * refuses the second as a replay.
 */
export function nip98(secret: Uint8Array, url: string, body: string): string {
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", createHash("sha256").update(body).digest("hex")],
        ["nonce", randomUUID()],
      ],
    },
    secret
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface Published {
  eventId: string;
  createdAt: number;
  /** The relay already held this exact event (or, for a channel, one with this id); nothing new was stored. */
  duplicate: boolean;
}

export class RelayClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly timeoutMs = 10_000
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Publish one event. Throws `RelayError` when the relay refuses it, with the relay's own reason. */
  async publish(secret: Uint8Array, kind: number, tags: string[][], content = "", createdAt?: number): Promise<Published> {
    const event = finalizeEvent({ kind, tags, content, created_at: createdAt ?? Math.floor(Date.now() / 1000) }, secret);
    const answer = (await this.post(secret, "/events", event)) as { accepted?: boolean; message?: string; event_id?: string };
    if (!answer || answer.accepted !== true) {
      throw new RelayError(409, answer?.message || "the relay did not accept the event");
    }
    return { eventId: event.id, createdAt: event.created_at, duplicate: (answer.message ?? "").startsWith("duplicate") };
  }

  async query(secret: Uint8Array, filters: Array<Record<string, unknown>>): Promise<Event[]> {
    const answer = await this.post(secret, "/query", filters);
    if (!Array.isArray(answer)) throw new RelayError(502, "the relay answered a query with something other than a list");
    return answer as Event[];
  }

  private async post(secret: Uint8Array, path: string, body: unknown): Promise<unknown> {
    const raw = JSON.stringify(body);
    const url = this.baseUrl + path;
    const authorization = nip98(secret, url, raw);
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep the text for the error below
    }
    if (!response.ok) {
      const reason = typeof parsed === "object" && parsed && "error" in parsed ? String((parsed as { error: unknown }).error) : text;
      throw new RelayError(response.status, reason.slice(0, 300) || `relay answered ${response.status}`);
    }
    return parsed;
  }
}
