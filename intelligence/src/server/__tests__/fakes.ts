/**
 * Stand-ins for the two products and the language model, as real HTTP servers.
 *
 * The fake application enforces a small role table the way the generated one
 * does — by refusing — so the tests can ask the question that matters: does
 * the assistant ever show a person something the application would not?
 */
import { verifyStatement } from "../signing";

export const SECRET = "test-secret-test-secret-test-secret-123";

export const USERS: Record<string, { email: string; name: string; roles: string[]; master: boolean; reads: string[] }> = {
  "tok-agent": {
    email: "support.agent@crm.example.com",
    name: "Support Agent",
    roles: ["support_agent"],
    master: false,
    reads: ["bus_ticket", "bus_account"],
  },
  "tok-sales": {
    email: "sales.manager@crm.example.com",
    name: "Sales Manager",
    roles: ["sales_manager"],
    master: false,
    reads: ["bus_account", "bus_opportunity"],
  },
  "tok-admin": {
    email: "admin@admin.com",
    name: "Administrator",
    roles: ["administrator"],
    master: true,
    reads: ["bus_ticket", "bus_account", "bus_opportunity"],
  },
};

export const RECORDS: Record<string, Array<Record<string, unknown>>> = {
  bus_account: [
    { id: "a1", name: "Acme Corporation", industry: "Manufacturing", version: 1 },
    { id: "a2", name: "Globex", industry: "Energy" },
  ],
  bus_opportunity: [{ id: "o1", name: "Acme renewal", amount: 120000, stage: "negotiation", version: 1 }],
  bus_ticket: [{ id: "t1", subject: "Acme cannot sign in", status: "open" }],
};

const LABELS: Record<string, string> = {
  bus_account: "Account",
  bus_opportunity: "Opportunity",
  bus_ticket: "Ticket",
};

const sessionOf = (request: Request) => {
  const match = /(?:^|;\s*)crm_app\.session_token=([^;]+)/.exec(request.headers.get("cookie") ?? "");
  return match ? (USERS[match[1] ?? ""] ?? null) : null;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Writes the fake application accepted, so a test can see what ran and with which version. */
export const writes: Array<{ method: string; path: string; ifMatch: string | null; body: unknown; user: string }> = [];

export function startFakeApp(switches: { chatEnabled?: boolean; chatOnlyMode?: boolean } = {}) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/api/auth/sign-in/email" && request.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": "application/json",
            "set-cookie": "crm_app.session_token=tok-agent; Path=/; HttpOnly; SameSite=Lax",
          },
        });
      }
      const user = sessionOf(request);
      if (!user) return json({ message: "Unauthorized" }, 401);
      if (path === "/api/me") {
        return json({ data: { email: user.email, name: user.name, sysRoles: user.roles, isMaster: user.master } });
      }
      if (path === "/api/me/permissions") {
        return json({
          isMaster: user.master,
          windows: user.master ? [{ name: "Users", route: "/admin/users", category: "admin" }] : [],
          access: { roles: user.roles },
        });
      }
      if (path === "/api/sys/app-info") return json({ name: "CRM", ...switches });
      if (path === "/api/sys/tables") {
        return json({ data: user.reads.map((table) => ({ table_name: table, name: LABELS[table] })) });
      }
      const move = /^\/api\/bus\/([a-z_]+)\/([A-Za-z0-9_-]+)\/(actions|transition)$/.exec(path);
      if (move) {
        const [, table = "", id = "", what] = move;
        if (!user.reads.includes(table)) return json({ message: "Forbidden" }, 403);
        // Only the sales manager holds the Approve button, as a %%rbac line would give it.
        const mayApprove = table === "bus_opportunity" && user.roles.includes("sales_manager");
        if (what === "actions") {
          return json(mayApprove ? [{ event: "approve", to: "approved", label: "Approve" }] : []);
        }
        if (!mayApprove) return json({ message: "TRANSITION_FORBIDDEN" }, 403);
        const ifMatch = request.headers.get("if-match");
        if (ifMatch !== '"1"') return json({ message: "VERSION_CONFLICT" }, 409);
        writes.push({ method: "POST", path, ifMatch, body: await request.json(), user: user.email });
        return json({ data: { id, stage: "approved" } });
      }
      const bus = /^\/api\/bus\/([a-z_]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(path);
      if (bus) {
        const [, table = "", id] = bus;
        if (!user.reads.includes(table)) return json({ message: "Forbidden" }, 403);
        const rows = RECORDS[table] ?? [];
        if (id && request.method === "PATCH") {
          const ifMatch = request.headers.get("if-match");
          const current = rows.find((candidate) => candidate.id === id)?.version ?? 1;
          if (ifMatch !== `"${current}"`) return json({ message: "VERSION_CONFLICT" }, 409);
          writes.push({ method: "PATCH", path, ifMatch, body: await request.json(), user: user.email });
          return json({ data: { id } });
        }
        if (id) {
          const row = rows.find((candidate) => candidate.id === id);
          return row ? json({ data: row }) : json({ message: "Not found" }, 404);
        }
        const search = (url.searchParams.get("search") ?? "").toLowerCase();
        const found = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(search));
        return json({ data: found, meta: { total: found.length } });
      }
      return json({ message: "Not found" }, 404);
    },
  });
}

export function startFakeReport() {
  const delegated: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/report/api/chat/delegate" && request.method === "POST") {
        const { assertion } = (await request.json()) as { assertion: string };
        const claims = await verifyStatement(SECRET, assertion, "report-delegate");
        if (!claims) return json({ error: "Refused" }, 401);
        delegated.push(claims.sub);
        return json({
          setCookie: [`ers.session_token=for-${claims.sub}; Path=/; HttpOnly; SameSite=Lax`],
          expiresAt: Date.now() + 600_000,
        });
      }
      const cookie = request.headers.get("cookie") ?? "";
      if (!cookie.includes("ers.session_token=for-")) return json({ error: "Unauthorized" }, 401);
      if (path === "/report/api/search") {
        return json({ items: [{ kind: "report", id: "r1", name: "Accounts by status" }] });
      }
      if (path === "/report/api/reports/r1") {
        // The Support Agent's reporting role does not include this report.
        return cookie.includes("support.agent") ? json({ error: "Forbidden" }, 403) : json({ id: "r1" });
      }
      return json({ error: "Not found" }, 404);
    },
  });
  return { server, delegated };
}

/**
 * An OpenAI-compatible endpoint that plays a script: one streamed response per
 * request, each either a tool call or plain text.
 */
export type ScriptStep =
  | { tool: string; args: Record<string, unknown> }
  | { text: string };

export function startFakeModel(script: ScriptStep[]) {
  const requests: any[] = [];
  let turn = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      const step = script[Math.min(turn++, script.length - 1)] ?? { text: "" };
      const chunk = (delta: unknown, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          created: 0,
          model: "fake",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      const body =
        "tool" in step
          ? chunk({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call_${turn}`,
                  type: "function",
                  function: { name: step.tool, arguments: JSON.stringify(step.args) },
                },
              ],
            }) + chunk({}, "tool_calls")
          : chunk({ role: "assistant", content: step.text }) + chunk({}, "stop");
      return new Response(`${body}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { server, requests };
}
