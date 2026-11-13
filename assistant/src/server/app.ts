/**
 * The assistant's HTTP surface, as one `fetch` function.
 *
 * Everything is under the base path (`/chat`):
 *
 *   GET  /chat/healthz              liveness, no session
 *   GET  /chat/switches             the administrator's two switches as last read (503 until known)
 *   ALL  /chat/api/auth/*           the generated application's own sign-in, passed through
 *   GET  /chat/api/session          who is signed in, and the administrator's two switches
 *   POST /chat/api/tickets          exchange an intent for a single-use ticket
 *   GET  /chat/open/<ticket>        redeem a ticket: redirect the frame to the real page
 *   POST /chat/api/actions/<id>/confirm   run a change the assistant proposed (the person's own press)
 *   POST /chat/api/actions/<id>/decline   drop it
 *   GET  /chat/api/audit            the audit trail (administrators)
 *   ALL  /chat/api/copilotkit/*     the CopilotKit runtime
 *   GET  /chat/*                    the built client
 *
 * Identity is the generated application's session cookie, which the browser
 * sends because all three services share one origin. The assistant holds no
 * password, no role table and no session of its own.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  BuiltInAgent,
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import { ActionStore, execute } from "./actions";
import { DurableAgentRunner, MemoryThreadStore, type ThreadStore } from "./durable";
import type { AuditLog } from "./audit";
import type { AssistantConfig } from "./config";
import {
  AppClient,
  type ChatSwitches,
  delegateReportSession,
  type Person,
  ReportClient,
  type ReportSession,
} from "./products";
import { type Clients, NotAvailable, resolveIntent } from "./registry";
import { clientAddress, RateLimiter } from "./ratelimit";
import { signStatement } from "./signing";
import { MemorySwitchStore, type Switches, type SwitchStore } from "./switches";
import type { Intent, TicketService } from "./tickets";
import { buildTools, SYSTEM_PROMPT } from "./tools";

export const EMBED_COOKIE = "chat_embed";

export interface AssistantDeps {
  config: AssistantConfig;
  tickets: TicketService;
  audit: AuditLog;
  /** Where the last reading of the administrator's switches is kept; in memory when absent. */
  switches?: SwitchStore;
  /** Serves the built client; absent in tests. */
  serveClient?: (request: Request, path: string) => Promise<Response> | Response;
  /** Where conversations are saved so they survive a restart; in memory when absent. */
  threads?: ThreadStore;
  /** Proposed changes awaiting confirmation; the tests share one to propose from outside. */
  actions?: ActionStore;
  /** Replaces the language model; the tests pass a scripted one. */
  model?: unknown;
}

interface Caller {
  person: Person;
  cookie: string;
  switches: ChatSwitches;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const NOT_AVAILABLE_PAGE = `<!doctype html><meta charset="utf-8"><title>Not available</title>
<body style="font:15px system-ui;margin:3rem;color:#444">
<p><strong>This page is not available.</strong></p>
<p>The link has been used or has expired. Ask the assistant to open it again.</p>`;

export function createAssistant(deps: AssistantDeps): (request: Request) => Promise<Response> {
  const { config, tickets, audit } = deps;
  const base = config.basePath;
  const actions = deps.actions ?? new ActionStore(config.actionTtlSeconds);
  const limiter = new RateLimiter();
  const perMinute = (max: number) => ({ max, windowSeconds: 60 });
  const tooMany = (retryAfterSeconds: number): Response =>
    json({ error: "Too many requests. Try again shortly." }, 429, { "retry-after": String(retryAfterSeconds) });

  // Short caches: a role taken away, or the feature switched off, takes effect within seconds.
  const people = new Map<string, { until: number; caller: Caller | null }>();
  const reportSessions = new Map<string, ReportSession>();
  // The switches as last read from the application; null until one is known. See switches.ts
  // for why "not known yet" is never reported as "off".
  const switchStore = deps.switches ?? new MemorySwitchStore();
  let lastSwitches: Switches | null = null;

  // What is known to be written down. Compared against this, not against memory: a save that
  // failed must be tried again at the next reading, or a restart would come back with the
  // older row and report it as known.
  let savedSwitches: Switches | null = null;
  const same = (a: Switches | null, b: Switches): boolean =>
    a !== null && a.enabled === b.enabled && a.chatOnly === b.chatOnly;

  // Saves run one after another, so the last one written is the last one read. Until a
  // write lands, what is stored is unknown; and it counts as saved only if it is still the
  // latest reading, or a slower, older save could finish last and be believed.
  let saving: Promise<void> = Promise.resolve();

  const rememberSwitches = (next: Switches): void => {
    lastSwitches = next;
    if (same(savedSwitches, next)) return;
    savedSwitches = null;
    saving = saving
      .then(() => switchStore.save(next))
      .then(() => {
        if (lastSwitches === next) savedSwitches = next;
      })
      .catch(() => undefined);
  };

  /** What this process knows, else what the last one wrote down, else nothing. */
  const knownSwitches = async (): Promise<Switches | null> => {
    if (lastSwitches) return lastSwitches;
    const stored = await switchStore.load().catch(() => null);
    // A reading taken while the load was pending is newer than anything stored.
    lastSwitches ??= stored;
    return lastSwitches;
  };

  async function identify(request: Request): Promise<Caller | null> {
    const cookie = request.headers.get("cookie") ?? "";
    if (!cookie.includes("session_token")) return null;
    const cached = people.get(cookie);
    if (cached && cached.until > Date.now()) return cached.caller;
    const app = new AppClient(config, cookie);
    const person = await app.me();
    const caller = person ? { person, cookie, switches: await app.switches() } : null;
    if (caller) rememberSwitches({ enabled: caller.switches.enabled, chatOnly: caller.switches.chatOnly });
    people.set(cookie, { until: Date.now() + 15_000, caller });
    if (people.size > 5000) people.clear();
    return caller;
  }

  async function reportSession(person: Person): Promise<ReportSession> {
    const cached = reportSessions.get(person.email);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached;
    const session = await delegateReportSession(config, person);
    reportSessions.set(person.email, session);
    return session;
  }

  const clientsFor = (caller: Caller): Clients => ({
    app: new AppClient(config, caller.cookie),
    report: async () => new ReportClient(config, await reportSession(caller.person)),
  });

  const embedCookie = async (person: Person): Promise<string> => {
    const value = await signStatement(
      config.bridgeSecret,
      { aud: "embed", sub: person.email },
      config.embedTtlSeconds
    );
    const secure = config.publicOrigin.startsWith("https://") ? "; Secure" : "";
    return `${EMBED_COOKIE}=${value}; Path=/; Max-Age=${config.embedTtlSeconds}; HttpOnly; SameSite=Lax${secure}`;
  };

  const model =
    deps.model ??
    createOpenAICompatible({
      name: "local",
      baseURL: config.ai.baseUrl,
      apiKey: config.ai.apiKey,
    }).chatModel(config.ai.model);

  const runner = new DurableAgentRunner(deps.threads ?? new MemoryThreadStore());
  const runtime = new CopilotRuntime({
    // Built per request, so the tools close over this person's own session.
    agents: async ({ request }) => {
      const caller = await identify(request);
      if (!caller) throw new Error("Not signed in");
      return {
        default: new BuiltInAgent({
          model: model as never,
          prompt: `${SYSTEM_PROMPT}\n\nYou are talking to ${caller.person.name}. The application is called ${caller.switches.appName}.`,
          maxSteps: 8,
          tools: buildTools({ config, person: caller.person, clients: clientsFor(caller), audit, actions }),
        }),
      };
    },
    // A conversation belongs to the person who started it; nobody else can list, read or continue it.
    identifyUser: async (request) => {
      const caller = await identify(request);
      if (!caller) throw new Error("Not signed in");
      // Saved conversations come back before the runtime asks whose they are.
      await runner.restore(caller.person.email).catch(() => undefined);
      return { id: caller.person.email, name: caller.person.name };
    },
    runner,
  });
  const copilot = createCopilotRuntimeHandler({ runtime, basePath: `${base}/api/copilotkit` });

  /** The application's own Better Auth endpoints, so the assistant's sign-in form posts same-path. */
  async function passAuthThrough(request: Request, rest: string, search: string): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.set("origin", config.publicOrigin);
    const upstream = await fetch(`${config.appApiUrl}/api/auth/${rest}${search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      redirect: "manual",
    });
    const out = new Headers();
    out.set("content-type", upstream.headers.get("content-type") ?? "application/json");
    out.set("cache-control", "no-store");
    for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie);
    people.clear();
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) {
      return new Response("Not found", { status: 404 });
    }
    const path = url.pathname.slice(base.length) || "/";

    if (path === "/healthz") return json({ ok: true });

    // Everything without a session — and sign-in attempts — is limited by network address.
    if (path === "/switches" || path.startsWith("/open/") || path.startsWith("/api/auth/")) {
      const verdict = limiter.check(`ip:${clientAddress(request)}`, perMinute(config.rateLimits.perAddress));
      if (!verdict.ok) return tooMany(verdict.retryAfterSeconds);
    }
    // Two booleans and nothing about anybody: the reporting platform asks without a session.
    // 503 until a reading exists, so "not known yet" is never taken for "off".
    if (path === "/switches") {
      const known = await knownSwitches();
      return known ? json({ known: true, ...known }) : json({ known: false }, 503);
    }

    if (path.startsWith("/api/auth/")) {
      return passAuthThrough(request, path.slice("/api/auth/".length), url.search);
    }

    if (path.startsWith("/open/")) {
      const caller = await identify(request).catch(() => null);
      const result = await tickets.redeem(path.slice("/open/".length), caller?.person.email ?? null);
      const enabled = caller?.switches.enabled === true;
      if (!result.ok || !caller || !enabled) {
        return new Response(NOT_AVAILABLE_PAGE, {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      const headers = new Headers({
        location: result.ticket.path,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      headers.append("set-cookie", await embedCookie(caller.person));
      if (result.ticket.intent.product === "report") {
        // The reporting platform's own session, for this person, set by this origin.
        const session = await reportSession(caller.person).catch(() => null);
        for (const cookie of session?.setCookie ?? []) headers.append("set-cookie", cookie);
      }
      return new Response(null, { status: 302, headers });
    }

    if (path.startsWith("/api/")) {
      let caller: Caller | null;
      try {
        caller = await identify(request);
      } catch {
        // "Could not check" is not "signed out": do not send anyone to the sign-in form for an outage.
        return json({ error: "The application could not be reached." }, 503);
      }
      if (!caller) {
        const verdict = limiter.check(`ip:${clientAddress(request)}`, perMinute(config.rateLimits.perAddress));
        return verdict.ok ? json({ error: "Not signed in" }, 401) : tooMany(verdict.retryAfterSeconds);
      }
      const user = limiter.check(`user:${caller.person.email}`, perMinute(config.rateLimits.perUser));
      if (!user.ok) return tooMany(user.retryAfterSeconds);

      if (path === "/api/session") {
        return json(
          {
            user: { email: caller.person.email, name: caller.person.name, admin: caller.person.isMaster },
            enabled: caller.switches.enabled,
            chatOnly: caller.switches.chatOnly,
            appName: caller.switches.appName,
          },
          200,
          caller.switches.enabled ? { "set-cookie": await embedCookie(caller.person) } : {}
        );
      }

      if (!caller.switches.enabled) return json({ error: "The assistant is switched off." }, 403);

      if (path === "/api/tickets" && request.method === "POST") {
        const intent = (await request.json().catch(() => null)) as Intent | null;
        if (!intent || typeof intent !== "object") return json({ error: "Bad request" }, 400);
        try {
          const target = await resolveIntent(config, clientsFor(caller), intent);
          const ticket = await tickets.issue(caller.person.email, intent, target);
          return json({ ticket });
        } catch (error) {
          if (error instanceof NotAvailable) return json({ error: error.message }, 404);
          return json({ error: "The system could not be reached." }, 503);
        }
      }

      const decision = /^\/api\/actions\/([A-Za-z0-9_-]{1,64})\/(confirm|decline)$/.exec(path);
      if (decision && request.method === "POST") {
        // A change is the person's own press, from this site: a cross-site form or a script
        // on another origin carries their cookie but not this origin.
        const origin = request.headers.get("origin");
        if (origin !== config.publicOrigin || !request.headers.get("content-type")?.includes("application/json")) {
          return json({ error: "Refused" }, 403);
        }
        const action = actions.take(decision[1] as string, caller.person.email);
        if (!action) return json({ error: "That change is no longer waiting. Ask again." }, 404);
        const target = `${action.change.object}:${action.change.id}`;
        if (decision[2] === "decline") {
          await audit.record({ user: caller.person.email, tool: `decline_${action.change.kind}`, target, outcome: "ok" }).catch(() => undefined);
          return json({ ok: true, message: "Declined." });
        }
        const outcome = await execute(new AppClient(config, caller.cookie), action.change);
        await audit
          .record({ user: caller.person.email, tool: `confirm_${action.change.kind}`, target, outcome: outcome.ok ? "ok" : "refused" })
          .catch(() => undefined);
        return json(outcome, outcome.ok ? 200 : 422);
      }

      if (path === "/api/audit" && request.method === "GET") {
        if (!caller.person.isMaster) return json({ error: "Administrators only" }, 403);
        return json({ entries: await audit.recent(200) });
      }

      if (path.startsWith("/api/copilotkit")) {
        // A conversation turn runs the language model; that is the expensive call, so it has its own limit.
        if (request.method === "POST") {
          const model = limiter.check(`model:${caller.person.email}`, perMinute(config.rateLimits.modelPerUser));
          if (!model.ok) return tooMany(model.retryAfterSeconds);
        }
        return copilot(request);
      }

      return json({ error: "Not found" }, 404);
    }

    if (deps.serveClient) return deps.serveClient(request, path);
    return new Response("Not found", { status: 404 });
  };
}
