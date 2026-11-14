/**
 * The assistant on one origin with stand-ins for everything it talks to: the
 * two products and the language model. For looking at the chat without
 * generating an application — `bun run build && bun scripts/preview.ts`, then
 * http://localhost:4300/chat/ (any e-mail and password sign in as the Support
 * Agent). The stand-ins are the ones the tests use.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAssistant } from "../src/server/app";
import { MemoryAuditLog } from "../src/server/audit";
import { loadConfig } from "../src/server/config";
import { MemoryTicketStore, TicketService } from "../src/server/tickets";
import { SECRET, startFakeApp, startFakeModel, startFakeReport } from "../src/server/__tests__/fakes";

const port = Number(process.env.PORT ?? 4300);
const app = startFakeApp();
const report = startFakeReport();
// PREVIEW_SCENARIO=propose shows the confirmation card instead of opening a record.
const model = startFakeModel(
  process.env.PREVIEW_SCENARIO === "propose"
    ? [
        {
          tool: "propose_update",
          args: { object: "bus_account", id: "a1", title: "Acme Corporation", changes: { industry: "Retail" } },
        },
        { text: "I have prepared that change. It will not happen until you confirm it on the card." },
      ]
    : [
        { tool: "search_records", args: { query: "acme" } },
        { tool: "open_record", args: { object: "bus_account", id: "a1", title: "Acme Corporation" } },
        { text: "I found Acme Corporation and opened it beside this conversation." },
      ]
);

const config = loadConfig({
  CHAT_BRIDGE_SECRET: SECRET,
  APP_API_URL: `http://127.0.0.1:${app.port}`,
  REPORT_URL: `http://127.0.0.1:${report.server.port}`,
  AI_BASE_URL: `http://127.0.0.1:${model.server.port}/v1`,
  AI_MODEL: "fake",
  PUBLIC_ORIGIN: `http://localhost:${port}`,
});

const clientDir = resolve(import.meta.dir, "../dist/client");
const assistant = createAssistant({
  config,
  audit: new MemoryAuditLog(),
  tickets: new TicketService(new MemoryTicketStore(), config.ticketTtlSeconds),
  serveClient: (_request, path) => {
    const file = join(clientDir, path);
    if (path.startsWith("/assets/") && existsSync(file)) return new Response(Bun.file(file));
    return new Response(Bun.file(join(clientDir, "index.html")), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});

const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>
     <body style="font:15px system-ui;margin:2rem"><h1>${title}</h1>${body}
     <p style="color:#667">A stand-in page. The real one is the generated application's.</p>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );

Bun.serve({
  port,
  idleTimeout: 255,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/chat")) return assistant(request);
    if (url.pathname.startsWith("/app/")) return page("Account — Acme Corporation", "<p>Industry: Manufacturing</p>");
    if (url.pathname.startsWith("/report/")) return page("Report", "<p>Accounts by status</p>");
    return new Response("Not found", { status: 404 });
  },
});
console.log(`preview on http://localhost:${port}/chat/`);
