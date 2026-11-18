/**
 * Custody of each person's Nostr key.
 *
 * A person never handles a key: one is made the first time they use the assistant and kept,
 * encrypted with AES-256-GCM under `KEY_ENCRYPTION_KEY`, in `ob_keys` in `chatdb`. Losing that
 * encryption key loses every person's identity on the relay, so it is written once by `start.sh`
 * and never rotated casually.
 *
 * Two first requests for the same person can race; the database keeps the first key written and
 * both get it back, so a person never ends up with two identities.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { AssistantDatabase } from "../../server/database";

export interface PersonKey {
  secret: Uint8Array;
  pubkey: string;
  /** True only for the call that made the key, so the caller can admit it to the relay once. */
  created: boolean;
}

export interface KeyVault {
  keyFor(owner: string): Promise<PersonKey>;
}

export class MemoryKeyVault implements KeyVault {
  private readonly keys = new Map<string, Uint8Array>();

  async keyFor(owner: string): Promise<PersonKey> {
    const id = owner.toLowerCase();
    const existing = this.keys.get(id);
    if (existing) return { secret: existing, pubkey: getPublicKey(existing), created: false };
    const secret = generateSecretKey();
    this.keys.set(id, secret);
    return { secret, pubkey: getPublicKey(secret), created: true };
  }
}

/** Reads `KEY_ENCRYPTION_KEY`: 32 bytes, base64. Refuses anything else rather than guessing. */
export function encryptionKeyFrom(value: string | undefined): Buffer {
  const key = Buffer.from(value ?? "", "base64");
  if (key.length !== 32) throw new Error("KEY_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  return key;
}

export function seal(key: Buffer, plaintext: Uint8Array): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function open(key: Buffer, sealed: string): Uint8Array {
  const raw = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return new Uint8Array(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]));
}

const DDL = `CREATE TABLE IF NOT EXISTS ob_keys (
  owner_email TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL UNIQUE,
  secret_sealed TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

export class PostgresKeyVault implements KeyVault {
  private readonly ensure: () => Promise<void>;
  private readonly cache = new Map<string, Uint8Array>();

  constructor(
    private readonly database: AssistantDatabase,
    private readonly encryptionKey: Buffer
  ) {
    this.ensure = database.prepared(DDL);
  }

  async keyFor(owner: string): Promise<PersonKey> {
    const id = owner.toLowerCase();
    const cached = this.cache.get(id);
    if (cached) return { secret: cached, pubkey: getPublicKey(cached), created: false };
    await this.ensure();
    const fresh = generateSecretKey();
    const inserted = await this.database.pool.query(
      `INSERT INTO ob_keys (owner_email, pubkey, secret_sealed) VALUES ($1, $2, $3)
       ON CONFLICT (owner_email) DO NOTHING RETURNING owner_email`,
      [id, getPublicKey(fresh), seal(this.encryptionKey, fresh)]
    );
    const row = await this.database.pool.query<{ secret_sealed: string }>(
      "SELECT secret_sealed FROM ob_keys WHERE owner_email = $1",
      [id]
    );
    const secret = open(this.encryptionKey, row.rows[0]!.secret_sealed);
    this.cache.set(id, secret);
    return { secret, pubkey: getPublicKey(secret), created: (inserted.rowCount ?? 0) > 0 };
  }
}
