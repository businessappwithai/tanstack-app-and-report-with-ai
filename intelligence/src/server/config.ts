/**
 * Everything the assistant reads from its environment, in one place.
 *
 * The assistant is served under a prefix (`/chat`) on the same origin as the
 * generated application (`/app`, `/api`) and the reporting platform
 * (`/report`). It talks to both over the compose network, never through nginx.
 */

const trimSlash = (value: string): string => value.replace(/\/+$/, "");

const required = (
  env: Record<string, string | undefined>,
  name: string,
  fallbackInDev: string
): string => {
  const value = env[name];
  if (value && value.length > 0) return value;
  if (env.NODE_ENV === "production") {
    throw new Error(`${name} is required in production`);
  }
  return fallbackInDev;
};

export interface AssistantConfig {
  port: number;
  /** URL prefix the assistant is served under. Never ends with a slash. */
  basePath: string;
  /** The generated application's backend, reached directly. */
  appApiUrl: string;
  /** Where the browser finds the generated application. */
  appBasePath: string;
  /** The reporting platform, reached directly (it is built for its prefix). */
  reportUrl: string;
  /** Where the browser finds the reporting platform. */
  reportBasePath: string;
  /** Shared with both products: signs delegation assertions and the embed cookie. */
  bridgeSecret: string;
  /** The origin a browser sees. Sent as `Origin` when the assistant signs in for someone. */
  publicOrigin: string;
  databaseUrl: string | null;
  ai: { baseUrl: string; model: string; apiKey: string };
  /** Seconds a ticket may wait to be redeemed. */
  ticketTtlSeconds: number;
  /** Seconds the embed cookie lasts; the chat page renews it while it is open. */
  embedTtlSeconds: number;
  /** Seconds a proposed change waits for the person to confirm it. */
  actionTtlSeconds: number;
  /** The generated application's `assistant-skills/` folder, mounted read-only; null when there is none. */
  skillsDir: string | null;
  /** Requests per minute: by signed-in person, and by address when there is no session. 0 = off. */
  rateLimits: { perUser: number; perAddress: number; modelPerUser: number };
  /**
   * The Buzz relay that keeps threads, finished runs and memory (intelligence.md). Null when it is
   * not configured, and the assistant keeps them in memory instead. All four are required together:
   * a partial set is refused rather than read as "not configured".
   */
  buzz: { relayUrl: string; operatorSecret: string; botSecret: string; keyEncryptionKey: string } | null;
}

function buzzSettings(env: Record<string, string | undefined>): AssistantConfig["buzz"] {
  const names = ["BUZZ_RELAY_URL", "BUZZ_OPERATOR_SECRET", "BUZZ_BOT_SECRET", "KEY_ENCRYPTION_KEY"] as const;
  const values = names.map((name) => env[name]?.trim() || "");
  if (values.every((value) => value === "")) return null;
  const missing = names.filter((_, index) => values[index] === "");
  if (missing.length > 0) throw new Error(`Buzz is partly configured: ${missing.join(", ")} missing`);
  for (const name of ["BUZZ_OPERATOR_SECRET", "BUZZ_BOT_SECRET"] as const) {
    if (!/^[0-9a-f]{64}$/.test(env[name]!.trim())) throw new Error(`${name} must be 64 lowercase hex characters`);
  }
  return {
    relayUrl: trimSlash(values[0]!),
    operatorSecret: values[1]!,
    botSecret: values[2]!,
    keyEncryptionKey: values[3]!,
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AssistantConfig {
  return {
    port: Number(env.PORT ?? 4200),
    basePath: trimSlash(env.CHAT_BASE_PATH ?? "/chat"),
    appApiUrl: trimSlash(env.APP_API_URL ?? "http://127.0.0.1:4001"),
    appBasePath: trimSlash(env.APP_BASE_PATH ?? "/app"),
    reportUrl: trimSlash(env.REPORT_URL ?? "http://127.0.0.1:3000"),
    reportBasePath: trimSlash(env.REPORT_BASE_PATH ?? "/report"),
    bridgeSecret: required(env, "CHAT_BRIDGE_SECRET", "dev-only-chat-bridge-secret-change-me-32chars"),
    publicOrigin: trimSlash(env.PUBLIC_ORIGIN ?? "http://localhost"),
    databaseUrl: env.CHAT_DATABASE_URL ?? null,
    ai: {
      baseUrl: trimSlash(env.AI_BASE_URL ?? "http://127.0.0.1:8000/v1"),
      model: env.AI_MODEL ?? "qwen3.6:27b-mlx",
      apiKey: env.AI_API_KEY ?? "local",
    },
    ticketTtlSeconds: Number(env.CHAT_TICKET_TTL_SECONDS ?? 60),
    embedTtlSeconds: Number(env.CHAT_EMBED_TTL_SECONDS ?? 900),
    skillsDir: env.CHAT_SKILLS_DIR || null,
    actionTtlSeconds: Number(env.CHAT_ACTION_TTL_SECONDS ?? 300),
    rateLimits: {
      perUser: Number(env.CHAT_RATE_PER_USER ?? 240),
      perAddress: Number(env.CHAT_RATE_PER_ADDRESS ?? 60),
      modelPerUser: Number(env.CHAT_RATE_MODEL_PER_USER ?? 20),
    },
    buzz: buzzSettings(env),
  };
}
