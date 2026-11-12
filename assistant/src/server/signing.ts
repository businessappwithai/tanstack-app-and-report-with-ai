/**
 * Signed, short-lived statements shared by the assistant and the two products.
 *
 * One format, two uses:
 *  - a delegation assertion (`aud: "report-delegate"`), which asks the reporting
 *    platform for a session for one named person;
 *  - the embed cookie (`aud: "embed"`), which tells a product that a page load
 *    came through a ticket the assistant issued.
 *
 * The format is `<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`. It is
 * deliberately not a JWT: there is one algorithm and no header to negotiate,
 * so there is no "alg: none" to forget to refuse. Both products carry a copy of
 * `verifyStatement`; keep the three in step.
 */

export interface Statement {
  /** What the statement is for. A statement is refused for any other use. */
  aud: string;
  /** Who it is about: the person's e-mail address, lower-cased. */
  sub: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
  /** Unique id, so a verifier can refuse a replay. */
  jti: string;
  [claim: string]: unknown;
}

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromBase64Url = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Compare without leaking where the first difference is. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function signStatement(
  secret: string,
  claims: Omit<Statement, "exp" | "jti"> & { aud: string; sub: string },
  ttlSeconds: number,
  now: number = Date.now()
): Promise<string> {
  const payload: Statement = {
    ...claims,
    exp: Math.floor(now / 1000) + ttlSeconds,
    jti: randomToken(16),
  };
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${toBase64Url(await hmac(secret, body))}`;
}

/** The payload when the statement is genuine, unexpired and for `audience`; otherwise null. */
export async function verifyStatement(
  secret: string,
  token: string | null | undefined,
  audience: string,
  now: number = Date.now()
): Promise<Statement | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!sameBytes(await hmac(secret, body), fromBase64Url(signature))) return null;
  let payload: Statement;
  try {
    payload = JSON.parse(Buffer.from(fromBase64Url(body)).toString("utf8")) as Statement;
  } catch {
    return null;
  }
  if (payload.aud !== audience) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
  return payload;
}
