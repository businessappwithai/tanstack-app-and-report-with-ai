#!/usr/bin/env bun
/**
 * Write the chat profile's keys into an env file, once, and leave existing ones alone.
 *
 *   bun intelligence/scripts/chat-keys.ts
 *
 * The file is always `common/.runtime/.env`, found from this script's own location. It takes no
 * path argument on purpose: a script that appends secrets to whatever file it is named would write
 * them anywhere a caller (or an agent filling in the command) points it.
 *
 * | Variable                 | What it is                                                              |
 * |--------------------------|-------------------------------------------------------------------------|
 * | KEY_ENCRYPTION_KEY       | 32 bytes, base64: seals each person's Nostr key in chatdb (`ob_keys`)    |
 * | BUZZ_RELAY_PRIVATE_KEY   | the relay's own key                                                     |
 * | BUZZ_OPERATOR_SECRET     | the relay owner's key: creates channels and admits members              |
 * | RELAY_OWNER_PUBKEY       | its public key, which the relay is told is its owner                    |
 * | BUZZ_BOT_SECRET          | the assistant's key                                                     |
 *
 * Regenerating any of them strands what was made under the old one: every person's identity on the
 * relay (`KEY_ENCRYPTION_KEY`), every channel's ownership (the operator), every memory (the
 * assistant). So a value that is present is never replaced, as `start.sh` already does for its other
 * secrets; RELAY_OWNER_PUBKEY is re-derived only from a present operator secret.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";

if (process.argv.length > 2) {
  console.error("usage: bun intelligence/scripts/chat-keys.ts  (it writes common/.runtime/.env and takes no arguments)");
  process.exit(1);
}
const runtime = resolve(import.meta.dir, "../../common/.runtime");
mkdirSync(runtime, { recursive: true });
const file = join(runtime, ".env");

const present = new Map<string, string>();
if (existsSync(file)) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && match[2]) present.set(match[1]!, match[2]!);
  }
}

const written: string[] = [];
function ensure(name: string, make: () => string) {
  if (present.has(name)) return present.get(name)!;
  const value = make();
  appendFileSync(file, `${name}=${value}\n`);
  present.set(name, value);
  written.push(name);
  return value;
}

ensure("KEY_ENCRYPTION_KEY", () => randomBytes(32).toString("base64"));
ensure("BUZZ_RELAY_PRIVATE_KEY", () => bytesToHex(generateSecretKey()));
const operator = ensure("BUZZ_OPERATOR_SECRET", () => bytesToHex(generateSecretKey()));
ensure("RELAY_OWNER_PUBKEY", () => getPublicKey(hexToBytes(operator)));
ensure("BUZZ_BOT_SECRET", () => bytesToHex(generateSecretKey()));

const owner = present.get("RELAY_OWNER_PUBKEY");
if (owner !== getPublicKey(hexToBytes(operator))) {
  console.error("RELAY_OWNER_PUBKEY does not belong to BUZZ_OPERATOR_SECRET; fix the env file by hand rather than letting either be regenerated");
  process.exit(1);
}
for (const name of written) console.log(`  wrote ${name}`);
