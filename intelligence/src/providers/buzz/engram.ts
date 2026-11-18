/**
 * NIP-AE agent engrams (kind 30174), as Buzz defines them in `docs/nips/NIP-AE.md`.
 *
 * A memory is an event authored by the assistant's key, addressed to the person with a `p` tag,
 * whose `content` is NIP-44 v2 encrypted under the conversation key the two share. The `d` tag is
 * an HMAC of the memory's slug under that key, so the relay (and anyone watching it) learns
 * neither the slug nor the text. The newest event for a `d` is the memory's head; a head whose
 * `value` is null is a tombstone and the memory is gone.
 *
 * NIP-AE lets a body carry fields beyond `slug` and `value`. Ours carries the Intelligence
 * interface's `kind`, `scope`, `sourceThreadIds` and `createdAt`, which Buzz's own readers ignore.
 */
import { createHmac } from "node:crypto";
import * as nip44 from "nostr-tools/nip44";
import type { Event } from "nostr-tools/pure";

export const KIND_AGENT_ENGRAM = 30174;
const D_TAG_DOMAIN = Buffer.from("agent-memory/v1/d-tag");
const SLUG = /^mem\/[a-z0-9][a-z0-9_-]{0,63}(\/[a-z0-9][a-z0-9_-]{0,63})*$/;

export const conversationKey = (secret: Uint8Array, peerPubkey: string) => nip44.v2.utils.getConversationKey(secret, peerPubkey);

export function dTag(key: Uint8Array, slug: string): string {
  return createHmac("sha256", Buffer.from(key))
    .update(Buffer.concat([D_TAG_DOMAIN, Buffer.from([0]), Buffer.from(slug, "utf8")]))
    .digest("hex");
}

export interface EngramBody {
  slug: string;
  value: string | null;
  [field: string]: unknown;
}

export const encryptBody = (key: Uint8Array, body: EngramBody) => nip44.v2.encrypt(JSON.stringify(body), key);

/**
 * The live heads among events addressed between one agent and one counterparty, by NIP-AE's head
 * selection: a valid envelope, a body that decrypts and parses, a slug that re-derives to the `d`
 * tag; then the greatest `created_at` per `d`, ties broken by the lowest event id. Invalid events
 * are skipped, never guessed at.
 */
export function heads(events: Event[], key: Uint8Array, agentPubkey: string, counterparty: string): Array<{ event: Event; body: EngramBody }> {
  const best = new Map<string, { event: Event; body: EngramBody }>();
  for (const event of events) {
    if (event.kind !== KIND_AGENT_ENGRAM || event.pubkey !== agentPubkey) continue;
    const d = event.tags.filter((t) => t[0] === "d");
    const p = event.tags.filter((t) => t[0] === "p");
    if (d.length !== 1 || p.length !== 1 || p[0]![1] !== counterparty) continue;
    let body: EngramBody;
    try {
      const parsed = JSON.parse(nip44.v2.decrypt(event.content, key)) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      body = parsed as EngramBody;
    } catch {
      continue;
    }
    if (typeof body.slug !== "string" || !SLUG.test(body.slug)) continue;
    if (body.value !== null && typeof body.value !== "string") continue;
    if (dTag(key, body.slug) !== d[0]![1]) continue;
    const current = best.get(d[0]![1]!);
    if (!current || event.created_at > current.event.created_at || (event.created_at === current.event.created_at && event.id < current.event.id)) {
      best.set(d[0]![1]!, { event, body });
    }
  }
  return [...best.values()];
}
