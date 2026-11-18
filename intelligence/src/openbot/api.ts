/**
 * The part of OpenBot's server API that OpenBot's MIT web app needs, answered by us.
 *
 * OpenBot's own server is a closed image and needs CopilotKit Intelligence; neither is used. Its
 * API contract (`api/openapi.yaml`, MIT) is public, so the app runs against this instead. Three
 * kinds of answer:
 *
 * - **Implemented** — conversations, the one Bot, the person, the deployment, memory: answered from
 *   the Intelligence interface, for the signed-in application person, in the contract's shapes.
 * - **Quiet** — reads about features this deployment does not have (approvals, routines,
 *   connections…): the smallest body the contract accepts, so the app draws an empty list rather
 *   than an error. `docs/phase-7-findings.md` lists what the app's core paths call.
 * - **Everything else** — 501 `NOT_AVAILABLE_IN_THIS_DEPLOYMENT`, as problem+json.
 *
 * Nothing here decides access. Every read and write names the signed-in person as owner, and the
 * provider answers someone else's thread or memory as absent.
 */
import type { Intelligence, LastMessage, MemorySummary, ThreadMessage, ThreadSummary } from "../interface/types";
import { ThreadExistsError } from "../interface/types";
import { OPENBOT_OPERATIONS, type OpenBotOperation } from "./operations.generated";

export interface OpenBotPerson {
  email: string;
  name: string;
}

export interface OpenBotOptions {
  intelligence: Intelligence;
  /** The one Bot this deployment has: the assistant. Its id is the CopilotKit agent id. */
  bot: { id: string; name: string; description: string };
  /** The organization name the app shows. */
  organizationName: string;
}

const ORGANIZATION = "default";

/** Reads about features this deployment does not offer: answered with the contract's empty shape. */
const QUIET = new Set([
  "announceComponents",
  "getApprovalPreferences",
  "getApprovalSettings",
  "getModelCatalogue",
  "getPersonBrowser",
  "getPreferences",
  "getSetupChecklist",
  "getShortenedToolNames",
  "listApprovalRules",
  "listApprovals",
  "listBotAttention",
  "listBotGrants",
  "listCheckInItems",
  "listCheckIns",
  "listComponents",
  "listConversationGrants",
  "listInvitations",
  "listPersonApprovalRules",
  "listQuestions",
  "listReactions",
  "listTasks",
  "markConversationRead",
  "recordAppError",
  "recordNudgeEvent",
  "recordProductEvent",
  "signalConversationBusy",
]);

const COMPILED = OPENBOT_OPERATIONS.map((operation) => ({ operation, pattern: new RegExp(operation.pattern) }));

const problem = (status: number, code: string, detail: string) =>
  new Response(JSON.stringify({ type: "about:blank", title: code, status, detail, code }), {
    status,
    headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
  });
const ok = (body: unknown, status = 200) =>
  status === 204
    ? new Response(null, { status: 204 })
    : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function find(method: string, path: string): { operation: OpenBotOperation; params: string[] } | null {
  for (const { operation, pattern } of COMPILED) {
    if (operation.method !== method) continue;
    const match = pattern.exec(path);
    if (match) return { operation, params: match.slice(1).map(decodeURIComponent) };
  }
  return null;
}

const oneLine = (text: string, max = 280) => text.replace(/\s+/g, " ").trim().slice(0, max);

export function createOpenBotApi(options: OpenBotOptions) {
  const { intelligence, bot } = options;

  const botBody = () => ({
    id: bot.id,
    name: bot.name,
    title: bot.name,
    roleDescription: bot.description,
    avatarSeed: bot.id,
    visibility: "public",
    hidden: false,
    pinned: true,
    systemOwned: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    canManage: false,
    mine: false,
    assignedToMe: true,
    builtIn: true,
    runsOnOpenBotModel: true,
    keyFromOpenBot: true,
    isolationActive: false,
    isolationOffReason: null,
  });

  const conversationOf = (thread: ThreadSummary) => ({
    id: thread.id,
    name: thread.name ?? "New conversation",
    botIds: [thread.agentId],
    threadId: thread.id,
    active: !thread.archived,
    lastMessageAt: thread.lastMessage?.at ?? thread.lastRunAt,
    summary: thread.name,
    opening: thread.name,
    lastMessage: thread.lastMessage?.text ?? null,
    lastMessageBotId: thread.lastMessage && thread.lastMessage.by !== "person" ? thread.lastMessage.by.agentId : null,
    createdAt: thread.createdAt,
    pinned: thread.pinned,
    lastReadAt: null,
    canRename: true,
    task: false,
    work: [],
  });

  const messageOf = (owner: string, agentId: string) => (message: ThreadMessage) => {
    const role = message.role === "user" ? "person" : message.role === "assistant" ? "bot" : message.role === "tool" ? "tool" : "system";
    const text = typeof message.content === "string" ? message.content : message.content == null ? "" : JSON.stringify(message.content);
    const calls = (message as unknown as { toolCalls?: unknown }).toolCalls;
    const toolCalls = Array.isArray(calls) ? calls.length : 0;
    return {
      id: message.id,
      role,
      personId: role === "person" ? owner : null,
      botId: role === "bot" ? agentId : null,
      text,
      status: "completed",
      createdAt: null,
      ...(toolCalls > 0 ? { toolCalls } : {}),
    };
  };

  const memoryOf = (memory: MemorySummary) => ({
    id: memory.id,
    content: memory.content,
    provenance: memory.sourceThreadIds.length > 0 ? "conversation" : "person",
    sourceId: memory.sourceThreadIds[0] ?? null,
    enabled: memory.invalidatedAt === null,
    reviewState: "confirmed",
    formedBy: memory.sourceThreadIds.length > 0 ? "bot" : "person",
    formedByBotId: memory.sourceThreadIds.length > 0 ? bot.id : null,
    sourceApp: null,
    sourceLink: null,
    observedAt: null,
    createdAt: memory.createdAt,
    updatedAt: memory.invalidatedAt ?? memory.createdAt,
  });

  type Handler = (context: { owner: string; person: OpenBotPerson; params: string[]; query: URLSearchParams; body: any }) => Promise<Response>;

  const handlers: Record<string, Handler> = {
    async getDeployment() {
      return ok({
        edition: "team",
        localEvaluation: false,
        generativeUi: false,
        selfHostBanner: false,
        transcription: false,
        voice: false,
        durableHistory: true,
        authProviders: [],
        ssoConfigured: false,
        ssoRequired: false,
        builtInBots: true,
        isolatedBots: false,
        botComputers: false,
      });
    },
    async listOrganizations() {
      return ok({
        organizations: [{ id: ORGANIZATION, slug: ORGANIZATION, name: options.organizationName, role: "member", active: true, personal: false }],
        canCreate: false,
        nextCursor: null,
      });
    },
    async getPerson({ owner, person }) {
      return ok({
        person: {
          id: owner,
          email: person.email,
          name: person.name,
          image: null,
          role: "member",
          needsName: false,
          onboarding: null,
          providers: [],
          lastSignedInAt: null,
          revoked: false,
          configuredAdmin: false,
        },
        openbotVersion: null,
      });
    },
    async listBots() {
      return ok({ bots: [botBody()], nextCursor: null });
    },
    async getBot({ params }) {
      return params[1] === bot.id ? ok({ bot: botBody() }) : problem(404, "BOT_NOT_FOUND", "There is no such Bot here.");
    },
    async routeConversationMessage() {
      return ok({ botId: bot.id, name: bot.name, reason: "The only Bot here.", fallback: false, viaMention: false, undecided: null });
    },

    async listConversations({ owner }) {
      const threads = await intelligence.threads.list(owner);
      return ok({ conversations: threads.map(conversationOf), nextCursor: null });
    },
    async createConversation({ owner, body }) {
      const botIds: unknown = body?.botIds;
      if (!Array.isArray(botIds) || botIds.length !== 1 || botIds[0] !== bot.id) {
        return problem(400, "BOT_NOT_AVAILABLE", `Only ${bot.name} is available here.`);
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const thread = await intelligence.threads.create(owner, { threadId: crypto.randomUUID(), agentId: bot.id });
          const conversation = conversationOf(thread);
          return ok({ conversation: { id: conversation.id, name: conversation.name, botIds: conversation.botIds, threadId: conversation.threadId, active: true, lastMessageAt: null } }, 201);
        } catch (error) {
          if (!(error instanceof ThreadExistsError)) throw error;
        }
      }
      return problem(409, "CONVERSATION_ID_TAKEN", "Could not start a conversation; try again.");
    },
    async getConversation({ owner, params }) {
      const thread = await intelligence.threads.get(owner, params[1]!);
      if (!thread) return problem(404, "CONVERSATION_NOT_FOUND", "There is no such conversation.");
      const c = conversationOf(thread);
      return ok({ conversation: { id: c.id, name: c.name, botIds: c.botIds, threadId: c.threadId, active: c.active, lastMessageAt: c.lastMessageAt } });
    },
    async updateConversation({ owner, params, body }) {
      const changes: { name?: string | null; pinned?: boolean } = {};
      if (body && "title" in body) changes.name = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : null;
      if (body && typeof body.pinned === "boolean") changes.pinned = body.pinned;
      const thread = await intelligence.threads.update(owner, params[1]!, changes);
      return thread ? ok(conversationOf(thread)) : problem(404, "CONVERSATION_NOT_FOUND", "There is no such conversation.");
    },
    async deleteConversation({ owner, params }) {
      return (await intelligence.threads.delete(owner, params[1]!)) ? ok(null, 204) : problem(404, "CONVERSATION_NOT_FOUND", "There is no such conversation.");
    },
    async listConversationMessages({ owner, params }) {
      const thread = await intelligence.threads.get(owner, params[1]!);
      if (!thread) return problem(404, "CONVERSATION_NOT_FOUND", "There is no such conversation.");
      const messages = await intelligence.threads.messages(owner, thread.id);
      return ok({ messages: messages.map(messageOf(owner, thread.agentId)), nextCursor: null });
    },
    async recordConversationActivity({ owner, params, body }) {
      const text = typeof body?.text === "string" ? oneLine(body.text) : "";
      const at = typeof body?.at === "string" && !Number.isNaN(Date.parse(body.at)) ? new Date(body.at).toISOString() : new Date().toISOString();
      const by: LastMessage["by"] = typeof body?.botId === "string" && body.botId ? { agentId: body.botId } : "person";
      const thread = await intelligence.threads.get(owner, params[1]!);
      if (!thread) return problem(404, "CONVERSATION_NOT_FOUND", "There is no such conversation.");
      // A person's first words name the conversation until somebody renames it, as OpenBot does.
      const name = thread.name ?? (by === "person" && text ? oneLine(text, 80) : null);
      const updated = await intelligence.threads.update(owner, thread.id, { ...(text ? { lastMessage: { text, at, by } } : {}), ...(name !== thread.name ? { name } : {}) });
      return updated ? ok(null, 204) : problem(404, "CONVERSATION_NOT_FOUND", "There is no such conversation.");
    },
    async createConversationThread() {
      return ok({ threadId: crypto.randomUUID() }, 201);
    },
    async getConversationThread({ owner, params }) {
      const thread = await intelligence.threads.get(owner, params[1]!);
      return ok({ threadId: params[1]!, known: thread !== null });
    },

    async listMemories({ owner, params }) {
      if (!isMe(params[1]!, owner)) return problem(404, "PERSON_NOT_FOUND", "There is no such person.");
      const memories = await intelligence.memory.list(owner);
      return ok({ memories: memories.map(memoryOf), nextCursor: null });
    },
    async createMemory({ owner, params, body }) {
      if (!isMe(params[1]!, owner)) return problem(404, "PERSON_NOT_FOUND", "There is no such person.");
      const content = typeof body?.content === "string" ? body.content.trim() : "";
      if (!content) return problem(400, "MEMORY_EMPTY", "Say what to remember.");
      if (content.length > 4000) return problem(400, "MEMORY_TOO_LONG", "A memory is at most 4000 characters.");
      return ok(memoryOf(await intelligence.memory.create(owner, { content, kind: "topical", scope: "user" })), 201);
    },
    async updateMemory({ owner, params, body }) {
      if (!isMe(params[1]!, owner)) return problem(404, "PERSON_NOT_FOUND", "There is no such person.");
      const id = params[2]!;
      const current = (await intelligence.memory.list(owner)).find((m) => m.id === id);
      if (!current) return problem(404, "MEMORY_NOT_FOUND", "There is no such memory.");
      if (body?.enabled === false) {
        await intelligence.memory.forget(owner, id);
        return ok(memoryOf({ ...current, invalidatedAt: new Date().toISOString() }));
      }
      const content = typeof body?.content === "string" ? body.content.trim() : current.content;
      if (!content) return problem(400, "MEMORY_EMPTY", "Say what to remember.");
      if (content === current.content) return ok(memoryOf(current));
      const next = await intelligence.memory.supersede(owner, id, { content, kind: current.kind, scope: current.scope, sourceThreadIds: current.sourceThreadIds });
      return next ? ok(memoryOf(next)) : problem(404, "MEMORY_NOT_FOUND", "There is no such memory.");
    },
    async deleteMemory({ owner, params }) {
      if (!isMe(params[1]!, owner)) return problem(404, "PERSON_NOT_FOUND", "There is no such person.");
      return (await intelligence.memory.forget(owner, params[2]!)) ? ok(null, 204) : problem(404, "MEMORY_NOT_FOUND", "There is no such memory.");
    },
  };

  const isMe = (personId: string, owner: string) => personId === "me" || personId.toLowerCase() === owner;

  /** Answer one request under `/api/v2/`, for a signed-in person. */
  return async function handle(request: Request, path: string, person: OpenBotPerson): Promise<Response> {
    const found = find(request.method, path);
    if (!found) return problem(404, "NOT_FOUND", "There is no such address.");
    const { operation, params } = found;
    // Every organization-scoped address names the one organization there is.
    if (operation.path.startsWith("/api/v2/organizations/{organizationId}") && params[0] !== ORGANIZATION) {
      return problem(404, "ORGANIZATION_NOT_FOUND", "There is no such organization, or you are not in it.");
    }
    const owner = person.email.toLowerCase();
    const handler = handlers[operation.operationId];
    if (handler) {
      let body: unknown = null;
      if (request.method !== "GET" && request.method !== "DELETE") {
        const text = await request.text();
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            return problem(400, "INVALID_JSON", "The request body is not JSON.");
          }
        }
      }
      return handler({ owner, person, params, query: new URL(request.url).searchParams, body });
    }
    if (QUIET.has(operation.operationId)) return ok(operation.body, operation.status);
    return problem(501, "NOT_AVAILABLE_IN_THIS_DEPLOYMENT", `${operation.operationId} is not available in this deployment.`);
  };
}

export const OPENBOT_IMPLEMENTED = [
  "getDeployment", "listOrganizations", "getPerson", "listBots", "getBot", "routeConversationMessage",
  "listConversations", "createConversation", "getConversation", "updateConversation", "deleteConversation",
  "listConversationMessages", "recordConversationActivity", "createConversationThread", "getConversationThread",
  "listMemories", "createMemory", "updateMemory", "deleteMemory",
] as const;
export const OPENBOT_QUIET = QUIET;
