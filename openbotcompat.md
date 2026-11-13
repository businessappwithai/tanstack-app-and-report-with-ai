# A chat front door to the generated application and Enterprise Reporting, on open-source CopilotKit

## Context

Today a reader reaches the two products at `/app` and `/report`, each with its own sign-in and RBAC. The
goal is a third, optional surface: a chat workspace through which a signed-in user reaches any page of
either product by natural language, finds a record or document, and works on it in the real application
page embedded in the chat. Access must be exactly what the generated application's `%%rbac` gives that
user; the embedded address must be opaque; an administrator turns it on and can make chat the only way in.

**Revised direction (your last instruction):** OpenBot is removed completely. We build our own
assistant, similar in purpose, on the **open-source CopilotKit packages only**, at their latest release.
No CopilotKit Intelligence, no CopilotKit cloud, no licence key, no third-party checkout.

Decisions carried over: opaque single-use tickets plus lock-down (no per-path encryption); in chat-only
mode administrators keep direct access. The earlier Intelligence and source-pinning decisions no longer
apply.

Assumption to confirm: the code lives in **`assistant/`** in `tanstack-app-and-report-with-ai`. You asked
for `openbot/` when it was OpenBot; say so if you want that name kept.

## Patterns followed

| Pattern | Where it comes from | How this plan applies it |
|---|---|---|
| The assistant acts with the user's own identity, never a service account | SAP Joule principal propagation, Entra on-behalf-of, RFC 8693 | The user's own application session is forwarded on every call; reporting gets a delegated session for the same person |
| Navigate by intent, not by URL | Fiori intent-based navigation (`#SalesOrder-display`) | The model emits `{object, action, id}`; the server resolves the address |
| Capability types | Joule: navigational, informational, transactional | Three tool families, shipped in that order |
| Security-trimmed search | Glean, Now Assist | Search runs inside the products as the user; nothing unpermitted reaches the model |
| Application pages framed inside the chat | Teams Stage View, MCP Apps | An `AppFrame` component around a ticket URL |
| Human approval for writes; untrusted tool output | OWASP LLM Top 10 (excessive agency, prompt injection) | Every write is confirmed in the chat; tool results are passed as data, not instructions |

## What the codebase gives us and what it lacks

- **Generated app:** cookie-only Better Auth, cookie path `/` (`backend/src/lib/better-auth.ts.hbs`).
  `GET /api/me/permissions` already returns the caller's windows and grants; `GET /api/bus/:entity?search=`
  is already role-checked. Missing: a global search, an embed mode, a login that honours `?redirect`.
  `sys_system` + Admin → System Config already draws boolean settings as toggles.
- **Reporting:** production sends `X-Frame-Options: DENY` and `frame-ancestors 'none'` (`src/server.ts`).
  Missing: an embed mode, search (only saved queries have it), any way for a trusted service to obtain a
  user's session. Its accounts are per role; `roles.name` / `ds_roles.name` equal the application's role
  names (`scripts/seed-reporting-pack.ts`).
- **Orchestrator:** one nginx origin; root `/api/`, `/assets/`, `/_build/` belong to the generated app, so
  the assistant must be built for a prefix — `common/build/subpath-overlay.ts` already does that for
  `/report`. No service may `depends_on` a database.
- **CopilotKit today:** generator pins `1.68.1`, reporting `^1.69.2`. The assistant uses the latest
  release on its own lockfile; the two products are not upgraded by this work.
- Field-level access is not enforced in the generated app today; out of scope, listed under Risks.

## Architecture

```
browser ─ nginx (one origin)
   ├─ /chat ───── assistant  (TanStack Start, Bun 1.4.4, CopilotKit runtime + UI) ── chatdb
   │                 │ forwards the user's own session cookie
   ├─ /app, /api ─ generated app   (its guards decide)
   └─ /report ──── reporting       (its guards decide)
```

**The service — `assistant/`.** TanStack Start like both products, Bun 1.4.4, `bun check`, no linter.
- Client: `@copilotkit/react-core` / `react-ui` chat, thread list, a workspace pane for embedded pages.
- Server: the open-source CopilotKit runtime with its built-in agent, pointed at the existing local
  OpenAI-compatible endpoint (`AI_BASE_URL`, `AI_MODEL`). The model must support tool calling.
- Own database `chatdb` (added to `common/docker/pg-init`): conversations, tickets, audit, saved prompts.
  No business data is stored beyond what the user's own conversation contains.
- Served at `/chat` through `subpath-overlay.ts`; nginx `location /chat/` with the variable-upstream
  pattern.

**Identity — one sign-in, the application's.** Same origin, so the assistant reads the generated app's
session cookie; its login screen posts to the app's own `/api/auth/sign-in/email`. Every tool call
forwards that cookie to the app's API, so `SessionAuthGuard`, `EntityAccessGuard` and `CapabilityService`
decide everything, unchanged. The assistant keeps no roles of its own.

**Reporting — a delegated session for the same person.** New `POST /report/api/auth/delegate`, callable
only by the assistant with a signed 60-second assertion (`CHAT_BRIDGE_SECRET`). It carries the user's
email, name and application role names (read from the app's `/api/me`, never from the browser). Reporting
upserts a per-person user, syncs `user_roles` / `ds_user_roles` to the roles of the same names
(administrator only when the application says `isMaster`), and returns its own session cookie, which the
assistant relays to the browser. `decideQueryRun` and `validateQueryAccess` then apply as for anyone.

**Tools (server-side, in the runtime).**
- Navigational: `find_pages`, `open_page`, `open_record`, `open_report`, `open_dashboard`, `open_chart`.
- Informational: `search_records`, `get_record`, `list_my_work` (`?awaiting=me`), `search_reports`,
  `run_report`, `ask_data` (reporting's NL→SQL pipeline, as the user).
- Transactional (last phase, each confirmed in chat): `create_record`, `update_record` (`If-Match`),
  `press_action` (the lifecycle buttons from `GET /bus/:e/:id/actions`).
- The intent registry is built per user from `/api/me/permissions` and the reporting lists. The model
  never sees or writes a path.

**Embedding and obfuscation.**
1. An "open" tool first reads the target as the user (access proven), then stores a ticket: 256-bit
   random, single use, 60 s, bound to user and target.
2. The chat renders `AppFrame`: `<iframe src="/chat/open/<ticket>" referrerpolicy="no-referrer">`.
   History stores the intent, never an address; reopening an old message mints a fresh ticket and
   re-checks access.
3. `/chat/open/<ticket>` redeems it, sets a short-lived signed embed cookie, and redirects to the page in
   embed mode. A spent, expired or foreign ticket answers one neutral "not available".
4. Embed mode in both products: no sidebar or header, links stay in the frame, a 401 posts a message to
   the chat instead of navigating to login.

**Administrator control — two switches in the generated app's `sys_system`:** `CHAT_ENABLED` and
`CHAT_ONLY_MODE`, on the existing System Config screen, exposed read-only through `/api/sys/app-info`.
- `CHAT_ENABLED` off: the assistant refuses sign-in, tools and tickets; the landing page shows no door.
- `CHAT_ONLY_MODE` on: for non-administrators both products refuse a page load that is not inside the
  chat frame with a valid embed cookie, and redirect to `/chat`. Administrators are exempt.
- Whether the container exists is a deployment choice: `./start.sh --with-chat`.

**"Similar to OpenBot" — what is in and what is not.**
- In: multiple saved conversations, generative UI cards (record, table, chart, approval), saved prompts
  per user, an audit trail of every tool call, an admin page (usage, audit, model settings).
- Later, if you want it: scheduled routines that run as their creator.
- Not built: a per-user computer with shell and browser, third-party app brokers, voice, mobile/desktop.

## Changes by repository

**`tanstack-app-and-report-with-ai`**
- `assistant/` — the service: routes, runtime and tools, intent registry, ticket service, `AppFrame`,
  migrations for `chatdb`, tests, `Dockerfile` (`oven/bun:1.4.4`), `README.md`.
- `docker-compose.yml` — `assistant` service behind profile `chat`; no database `depends_on`.
- `common/docker/nginx/default.conf` — `location /chat/` (streaming, long read timeout).
- `common/docker/pg-init` — `chatdb`. `start.sh` / `stop.sh` — `--with-chat`, the profile,
  `CHAT_BRIDGE_SECRET` written once with the other secrets.
- `common/build/landing.ts` — a third door; `common/build/smoke.sh`; both workflows (path filters, a chat
  smoke step); `CLAUDE.md`.

**`tanstack-app-with-ai` (`packages/generator/templates/tanstack-start-nestjs/`)**
- New `GET /api/search` (reuses the per-entity guard; one call instead of one per entity).
- Seeds for the two `sys_system` keys; both in `/api/sys/app-info`.
- Frontend: embed mode in `__root.tsx.hbs` / `AppLayout`, the 401 handler in `contexts/auth-context.tsx`,
  the chat-only redirect, login honouring a same-site `?redirect`.
- Backend: the chat-only check and embed-cookie verification in `main.ts.hbs`.
- Regenerate-and-build is required; the fullstack and wasm bundles are rebuilt on CI's Bun.

**`tanstack-enterprise_reporting`**
- `src/server.ts` — `frame-ancestors 'self'` / `SAMEORIGIN` when `CHAT_EMBED=1` (default stays deny).
- `src/routes/api/auth/delegate.ts`; `src/routes/api/search.ts` (reports, charts, dashboards, saved
  queries, each behind its `:view`).
- Embed mode in `src/components/layout/app-shell.tsx`; chat-only redirect in `_authed.tsx`.
- `AuditAction` / `ResourceType` gain chat entries; delegated sign-ins and runs are audit-logged.

**`businessappwithai.github.io`** — no change.

## Phases

0. **Spike.** Latest CopilotKit on Bun 1.4.4 under `/chat`: streaming through nginx, tool calling on the
   local model, and which open-source piece persists conversations (else our own store in `chatdb`).
1. **Service and identity.** `assistant/`, sign-in through the app, reporting delegate, compose, nginx.
2. **Navigational + embed.** Intent registry, tickets, `AppFrame`, embed mode, frame headers.
3. **Informational.** Search endpoints, record and report reads, `ask_data`, result cards.
4. **Administrator control.** The two switches, chat-only lock-down, landing page.
5. **Transactional.** Create, update, action buttons, each behind a confirmation.
6. **Hardening.** Audit, rate limits, CI, documentation, pins in `deps.json` moved.

## Verification

- **Unit:** ticket single use, expiry and user binding; the registry never returns a page outside a
  user's permissions; the delegate endpoint refuses a bad, expired or replayed assertion.
- **RBAC parity, the test that matters:** on the CRM model, for each of the seven declared roles, every
  tool result equals what that user gets from the product's own API; "forbidden" and "does not exist"
  give the same neutral answer.
- **End to end (Playwright, in `build-and-run.yml`):** `./start.sh --with-chat`; sign in as
  `support.agent@…`; ask for an account by name and see the record open in the frame; ask for an entity
  that role cannot read and get a refusal; open a report and a dashboard; replay a spent ticket; turn on
  chat-only and confirm `/app` and `/report` redirect for that user and not the administrator; turn the
  feature off and confirm the door closes.
- **Existing checks stay green:** `bun run check:all` in `common/`; the generator's CI including
  "Generate an application and build it"; reporting's `bun run precommit`; QA of the generated app with
  the `qa-lifecycle-workflows` and `qa-app-with-ai` skills.
- **Security review** of the delegate endpoint, ticket service and chat-only check before merge.

## Risks and open items

- **Developer tools still show the frame's real address.** In chat-only mode that address is refused
  outside the chat frame; that is the protection, not secrecy.
- **Local model quality:** tool calling on the local endpoint decides how well natural language works.
- **Conversation persistence** in open-source CopilotKit is unconfirmed; Phase 0 decides library or own.
- **Three CopilotKit versions** will coexist (generator, reporting, assistant) until the products move.
- **Field-level access** remains unenforced in the generated application; separate work.
- **Reporting becomes per-person** when reached through chat (accounts created on first use); the
  per-role demo accounts remain for direct sign-in.

## Progress

**Done**
- `assistant/` — the service: identity from the application's session, product clients, the intent
  registry, single-use tickets, the audit trail (PostgreSQL, creating its own database), nine tools
  (find, search, read, my work, open record/page/report, search and run reports), the CopilotKit 1.87.0
  runtime with a per-request agent, and the client (sign-in, chat, framed workspace).
- Orchestrator wiring: the `assistant` compose service behind profile `chat`, nginx `/chat/`,
  `./start.sh --with-chat`, `CHAT_BRIDGE_SECRET` written once, the landing page's third door, a CI job.
- Reporting platform (its own pull request): delegated sign-in with role sync, search, embed mode,
  frame headers, chat-only mode. Checked against a running server on PostgreSQL.

- Generated application (its own pull request): the two administrator switches, chat-only mode
  enforced in the session guard, embed mode, and the frame-aware sign-out handling.
- Run together, outside Docker: a CRM application generated from these templates, the reporting
  platform and the assistant, on PostgreSQL. The Support Agent reads 5 of 17 entities through the
  assistant; a hidden entity is refused; a report page opens with a delegated session; chat-only refuses
  a direct call and admits the same person through the assistant; the Accounts page renders in the
  frame without the application's own chrome.

**Not done yet**
- The `deps.json` pins still name commits without the two products' sides. The composed stack works
  end to end only once those two pull requests are merged and the pins moved.
- A composed run (`./start.sh --with-chat`) has not been made: Docker was not available where this was
  built. The services were run together directly instead.
- No real language model has been used. Every conversation so far was a scripted stand-in, so how well
  a model picks tools is untested.
- Durable conversations and tickets (both in memory: one replica, lost on restart), the write tools
  with confirmation, rate limits, and an end-to-end run in `build-and-run.yml`.

**Changed from the plan above, and why:**
- The assistant is a Vite single-page client with a small Bun server, not TanStack Start. It needs no
  server rendering, and it is built for `/chat` directly rather than patched by `subpath-overlay.ts`.
- No `GET /api/search` is added to the generated application. The assistant searches each entity the
  person can read through the existing, already role-checked list endpoint; the result is the same and
  the generator is not touched for it.
- Conversation storage: open-source CopilotKit ships an in-memory runner and a SQLite runner, both
  enforcing per-person ownership. The checkpoint uses the in-memory one.
