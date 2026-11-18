/**
 * The assistant's process: the HTTP surface from `src/server/app.ts`, plus the
 * built client served from `dist/client` under the same prefix.
 */
import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { createAssistant } from "./src/server/app";
import { createAuditLog } from "./src/server/audit";
import { loadConfig } from "./src/server/config";
import { openDatabase } from "./src/server/database";
import { MemoryThreadStore, PostgresThreadStore } from "./src/server/durable";
import { createSwitchStore } from "./src/server/switches";
import { MemoryTicketStore, PostgresTicketStore, TicketService } from "./src/server/tickets";

const config = loadConfig();
const clientDir = resolve(import.meta.dir, "dist/client");
// One pool for everything the assistant keeps; in memory when no database is configured.
const database = config.databaseUrl ? openDatabase(config.databaseUrl) : null;
const tickets = database ? new PostgresTicketStore(database) : new MemoryTicketStore();

/** Framing is for this origin's own pages only; nothing is cached that names a person. */
const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

function serveClient(_request: Request, path: string): Response {
  const relative = normalize(path).replace(/^(\.\.[/\\])+/, "");
  const file = join(clientDir, relative);
  if (path.startsWith("/assets/") && file.startsWith(clientDir) && existsSync(file)) {
    return new Response(Bun.file(file), {
      headers: { "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
    });
  }
  const index = join(clientDir, "index.html");
  if (!existsSync(index)) return new Response("The client has not been built.", { status: 503 });
  return new Response(Bun.file(index), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...PAGE_HEADERS },
  });
}

const handle = createAssistant({
  config,
  audit: createAuditLog(database),
  switches: createSwitchStore(database),
  threads: database ? new PostgresThreadStore(database) : new MemoryThreadStore(),
  tickets: new TicketService(tickets, config.ticketTtlSeconds),
  serveClient,
});

setInterval(() => void tickets.sweep(Date.now()).catch(() => undefined), 30_000).unref();

const server = Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  // A model thinking between tool calls is quiet for a long time.
  idleTimeout: 255,
  fetch: (request) => handle(request),
});

console.log(`assistant listening on :${server.port}${config.basePath}`);
