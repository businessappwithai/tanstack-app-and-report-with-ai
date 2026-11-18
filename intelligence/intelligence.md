# Intelligence — the chat front door, rebuilt on OpenBot over an open Intelligence interface on Buzz

The design for this directory, `intelligence/`. This directory was `assistant/`.

Everything the chat front door is, and everything this plan adds to it, lives here.

## Goal

A signed-in person reaches the two products at `/app` and `/report` today, each with its own sign-in and RBAC. The chat
front door is a third, optional way in. Through it a person can:
- reach any page of either product by asking for it;
- find a record or a document;
- work on it in the real application page, embedded beside the conversation.

Four things are fixed:
- **Access** is exactly what the generated application's `%%rbac` gives that person.
- **Addresses** stay opaque.
- **An administrator** turns the door on, and can make chat the only way in.
- **Everything is open source.** No closed service, no licence key, and no telemetry.

The first version is built and working. It is our own service on the open-source CopilotKit packages, with our own web
client. The next step rebuilds the parts a person sees and the parts that remember:

- **OpenBot** (`CopilotKit/OpenBot`, MIT) becomes the web client. It brings a thread list, memory review, approvals and a
  finished chat.
- **Buzz** (`block/buzz`, Apache-2.0) keeps threads, messages, run history, search, audit and memory.
- **An Intelligence interface of our own** sits between them. It is what CopilotKit Intelligence does, written as an open
  TypeScript contract, with Buzz as its production provider.

OpenBot's own server is a closed image, and it requires CopilotKit Intelligence, which is separately licensed. Neither is
used. Our server answers the part of OpenBot's API its client needs.

## Patterns followed

| Pattern | Where it comes from | How it is applied |
|---|---|---|
| The assistant acts with the person's own identity, never a service account | SAP Joule principal propagation, Entra on-behalf-of, RFC 8693 | The person's application session is forwarded on every call. Reporting gets a delegated session for the same person |
| Navigate by intent, not by URL | Fiori intent-based navigation (`#SalesOrder-display`) | The model emits `{object, action, id}`, and the server resolves the address |
| Capability types | Joule: navigational, informational, transactional | Three tool families, shipped in that order |
| Security-trimmed search | Glean, Now Assist | Search runs inside the products as the person; nothing they cannot see reaches the model |
| Application pages framed inside the chat | Teams Stage View, MCP Apps | A framed page behind a single-use ticket |
| Human approval for writes; tool output treated as untrusted | OWASP LLM Top 10 (excessive agency, prompt injection) | Every write is confirmed by the person. Tool results are passed as data, not instructions |
| Durable, owner-scoped threads and memory behind an interface | CopilotKit Intelligence's public client contract | `src/interface/`, implemented on Buzz |
| Signed, append-only event log as the system of record | Buzz (Nostr) | Every message, run event and memory change is a signed event on a relay we run |

## What is built (the foundation, unchanged by this plan)

### The service

The service is `intelligence/`: a Vite single-page client with a small `Bun.serve` server. It runs on CopilotKit 1.87.0's
open-source runtime, with its built-in agent pointed at the local OpenAI-compatible model (`AI_BASE_URL`, `AI_MODEL`).

| File | What it is |
|---|---|
| `server.ts` | The entry point |
| `src/server/app.ts` | Routes under `/chat`, and the runtime with an agent built per request |
| `src/server/tools.ts` | 13 tools. Navigational: `find_pages`, `open_page`, `open_record`, `open_report`. Informational: `search_records`, `get_record`, `list_my_work`, `search_reports`, `run_report`, `read_skill`. Transactional: `get_record_actions`, `propose_move`, `propose_update` |
| `src/server/products.ts` | The application and reporting clients |
| `src/server/registry.ts` | The only place a path is written. The intent registry is built per person from `/api/me/permissions` and the reporting lists, so the model never sees or writes a path |
| `src/server/tickets.ts` | Single-use tickets, in memory or in PostgreSQL |
| `src/server/actions.ts` | Proposals and their confirmation |
| `src/server/audit.ts` | The audit trail |
| `src/server/ratelimit.ts` | Rate limits |
| `src/server/switches.ts` | The administrator's switches |
| `src/server/skills.ts` | The application's skills |
| `src/server/durable.ts` | Saved conversations |
| `src/server/database.ts` | `chatdb`, which the service creates itself |
| `src/client/` | Sign-in, chat, and the framed workspace |

### Identity: one sign-in, the application's

- The service is on the same origin, so it reads the generated application's session cookie, and its sign-in posts to
  the application's own Better Auth.
- Every tool call forwards that cookie, so the application's guards decide everything. The assistant keeps no roles of
  its own.

### Reporting: a delegated session for the same person

- `POST /report/api/chat/delegate` takes a 60-second, single-use assertion signed with `CHAT_BRIDGE_SECRET`. It carries
  the person's email, name and application role names, read from the application's `/api/me` and never from the
  browser.
- Reporting upserts a per-person user and syncs `user_roles` and `ds_user_roles` to the roles of the same names. The
  person is an administrator there only when the application says so.
- Reporting then returns its own session cookie. `decideQueryRun` and `validateQueryAccess` apply as for anyone.

### Embedding and opaque addresses

1. An "open" tool first reads the target as the person, which proves access. Then it stores a ticket: 256-bit, single
   use, 60 seconds, bound to the person and the target.
2. The chat frames `/chat/open/<ticket>`. History stores the intent, never an address.
3. Redeeming the ticket sets a short-lived signed embed cookie and redirects to the page in embed mode. A spent,
   expired or foreign ticket gets one neutral "not available".
4. Both products have an embed mode: no sidebar or header, and a 401 is posted to the chat rather than sent to a sign-in
   page.

### Administrator control

Two switches live in the generated application's `sys_system`, `CHAT_ENABLED` and `CHAT_ONLY_MODE`. They are relayed at
`/chat/switches` and kept in `chatdb`. Until they are known, `/chat/switches` answers 503.

- **Chat-only mode** sends a non-administrator's page loads into the chat frame, in both products.
- **Administrators** are exempt.

### Writes

- `propose_move` and `propose_update` only propose.
- `POST /chat/api/actions/<id>/confirm` is the person's own press. It accepts same-origin JSON only, and runs the
  application's call with the version the record was read at.
- No move is proposed that the person has no button for.
- Status, identity, version and audit columns cannot be proposed at all.

### Limits and audit

- Rate limits per account, per address and per model turn; over the limit is a 429 with `Retry-After`.
- Every tool call is in `chat_audit`.

### Wiring outside this directory

- `docker-compose.yml`: service `assistant`, built from `./intelligence`, profile `chat`, no database `depends_on`.
- nginx: `location /chat/`.
- `pg-init`: `chatdb`.
- `./start.sh --with-chat`: writes `CHAT_BRIDGE_SECRET` once.
- `landing.ts`: the landing page's third door.
- `common/build/chat-smoke.sh`.
- `root-ci.yml`: the "Chat assistant" job.
- `build-and-run.yml`: the composed run.

### The products' sides, merged in their own repositories

- **Reporting:** the delegated sign-in with role sync, search, embed mode, frame headers behind `CHAT_EMBED=1`, and
  chat-only mode.
- **Generated application:** the two switches, chat-only mode enforced in the session guard, embed mode, frame-aware
  sign-out, and `assistant-skills/` beside `manual.html`.

### Proven together, outside Docker

On PostgreSQL, running a generated CRM application, the reporting platform and the assistant:
- the Support Agent reads 5 of 17 entities;
- a hidden entity is refused;
- a report opens with a delegated session;
- chat-only mode refuses a direct call and admits the same person through the assistant;
- a framed page renders without the application's chrome.

### Changed from the first design, and why

- **A Vite client with a Bun server, not TanStack Start.** No server rendering is needed.
- **No new `GET /api/search` in the generated application.** Each entity's role-checked list endpoint gives the same
  result.
- **Saved conversations wrap CopilotKit's in-memory runner.** Its thread endpoints are synchronous. This plan replaces
  that wrapper.

### Not done yet in the foundation

- A composed `./start.sh --with-chat` run has not finished here, because the disk allowance ran out. It runs in
  `build-and-run.yml`.
- No real language model has been used. Every conversation so far was a scripted stand-in.
- Pending proposals are held in memory for five minutes.
- `durable.ts` reaches into CopilotKit internals, and our client has no thread list, no way to reopen a thread and no
  memory.

The plan below closes all of these.

## The next shape

```
browser ── /chat/*  ─────────────────────────────► OpenBot app (MIT; built from a pinned checkout, served by us)
        ── /chat/api/v2/*, /api/auth/*, /api/copilotkit/* ─► intelligence server (ours, Bun)
                                                   │
                     src/openbot/  ── OpenBot API subset ──┐
                     src/server/   ── CopilotKit runtime, agent + 13 tools, identity, tickets, proposals
                     src/runtime/  ── IntelligenceRunner (a CopilotKit AgentRunner)
                                                           ▼
                     src/interface/ ── the Intelligence interface: threads · runs · realtime · memory · entitlements
                                                           ▼
                     src/providers/buzz/   (production)    src/providers/memory/  (tests, local dev)
                                                           ▼
                                    buzz-relay ── Postgres buzzdb, Redis   (pinned checkout, our Dockerfile)
```

### Directory layout

| Path | What it is |
|---|---|
| `intelligence.md` | This plan |
| `src/interface/` | The Intelligence interface, types only |
| `src/providers/memory/` | The interface held in memory: the test double and the local-dev default |
| `src/providers/buzz/` | The interface on a Buzz relay: keys, NIP-98/NIP-42, channels, events, memory |
| `src/runtime/` | `IntelligenceRunner`, CopilotKit's `AgentRunner` over the interface. It replaces `durable.ts` |
| `src/openbot/` | The OpenBot API subset, and serving the built app |
| `src/server/` | The existing server: identity, tools, tickets, proposals, switches, audit |
| `docker/buzz-relay.Dockerfile` | Builds the relay from the pinned Buzz checkout with cargo |
| `docker/openbot-app.Dockerfile` | Builds OpenBot's app from the pinned checkout with Bun 1.4.4 |
| `docs/` | Phase-7 findings (`docs/phase-7-findings.md`) |

### The Intelligence interface (`src/interface/`)

It is modelled on CopilotKit Intelligence's public client contract, which is MIT. It is an in-process TypeScript
interface, and its field names follow Intelligence's (`ThreadSummary`, `MemorySummary`), so phase 5 can put it on the
wire unchanged.

```ts
interface Intelligence {
  threads: ThreadStore;   // list · create (conflict if the id exists) · get · update (name, archived) · delete · messages
  runs: RunStore;         // record a finished run (compacted AG-UI events + message snapshot) · list a thread's runs
  memory: MemoryStore;    // list · create · supersede · forget · recall (keyword ranking in src/interface/recall.ts)
  changes: ThreadChanges; // subscribe to an owner's thread changes (created / updated / archived / deleted)
}
```

The full contract is `src/interface/types.ts`. Live run state (the lock, the stream in progress, stop) is not part of
it: it stays in the runner's process, as CopilotKit's own in-memory runner keeps it, and only a finished run is
recorded. Entitlements are not part of it either: the runtime reports its own (no licence), and nothing here forges one.

`owner` is the person's lower-cased email, as `identifyUser` returns it today. Every method refuses another owner's
thread or memory.

### The Buzz provider (`src/providers/buzz/`)

| Interface concept | On Buzz |
|---|---|
| A person | A custodial Nostr key made on their first sign-in, AES-256-GCM-encrypted in `ob_keys` (`chatdb`) under `KEY_ENCRYPTION_KEY`. Nobody handles it |
| The assistant | Its own key, relay role `Bot` |
| The operator | A relay key with role `Owner`. It creates channels and manages members |
| A thread | A private Stream channel whose members are the person and the assistant. Name and archived state are channel metadata |
| Messages | Stream messages signed by the person or the assistant, so they read naturally in the Buzz desktop app |
| Run events | NIP-AR artifacts (kind `45010`, `type: appwithai.agui-batch`, `run` and `seq` tags), one per batch, in the same channel. The relay rejects kinds it does not know, so no new kind is invented. Each event carries an id and a sequence number, and readers drop duplicates |
| Run lock, active run, stop | In process for one replica. A Redis lock with a TTL is needed for several replicas |
| Memory | Buzz's own convention: kind 30174, NIP-44 between the assistant's key and the person's, a slug `d` tag, tombstone delete. `kind`, `scope` and `sourceThreadIds` are in the encrypted body. For project scope, `p` is the assistant's key |
| Recall | The provider decrypts and ranks, by keyword plus vector similarity where an embeddings endpoint is configured |
| Search, audit | Buzz's own: full-text search, and the hash-chained audit log |

Tool results stay inside private channels, and the relay checks membership on every read. Signing uses `nostr-tools`
(Unlicense, public domain).

## Phases

The foundation's phases 0 to 6 are done (spike, service and identity, navigational and embed, informational,
administrator control, transactional, hardening). Numbering continues from there.

### 7. Spikes: settle the facts first

Buzz:
- Build `buzz-relay` alone with cargo (Rust 1.98, as the repository pins it; no pnpm). Run it on Postgres and Redis.
- Does it start without S3?
- From `crates/buzz-relay`, `buzz-sdk` and `buzz-admin`, learn:
  - how a channel is created and a member added;
  - whether a custom 4xxxx kind is accepted;
  - how single-community hosting is configured.
- What is `web/`, the Buzz web client in that repository?

OpenBot:
- Build the app with Bun 1.4.4.
- Run it against a recording stub that answers every OpenBot route with a minimal valid response and logs the call.
- In Chromium, exercise sign-in, home, a new conversation, chat and memory.
- Record:
  - the operation subset;
  - the auth calls;
  - which capability fields hide features;
  - whether it needs Intelligence mode;
  - how its base path is set.

The output is `docs/phase-7-findings.md`, plus updates to this file.

**Done.** The relay runs on PostgreSQL and Redis with `BUZZ_GIT_CONFORMANCE_PROBE=false` (no S3), and the whole Buzz
mapping was proven against it. OpenBot's app built on Bun 1.4.4 and chatted against a CopilotKit 1.88.0 runtime with
no Intelligence. The roughly 35 operations its core paths call are listed in the findings.

### 8. The interface and the in-memory provider — done

Covers `src/interface/` and `src/providers/memory/`. A conformance suite (`src/interface/__tests__/`) that every provider
must pass checks:
- owner isolation;
- a run-lock conflict;
- duplicate events dropped;
- replay from a cursor;
- stop;
- memory create, supersede, forget and recall.

### 9. The Buzz provider, and Buzz in the stack — done

- `src/providers/buzz/` passes the same suite against a real relay, including one that requires membership, where it
  admits each new person with kind 9030 (and without admitting, the relay refuses everything). It also passes NIP-AE's
  own test vectors.
- **Two defects the suite found and fixed.** First, a second create of a taken thread id added the second person to
  the channel before failing. Creating the channel is now the claim, and members are added only after a fresh create.
  Second, identical requests within a second were refused as NIP-98 replays. Every auth event now carries a nonce.
- **Checkouts:** `deps.json` pins `buzz` and `openbot` under `intelligence/.checkouts/` (gitignored), so everything for
  this stays in this directory.
- `docker/buzz-relay.Dockerfile`: cargo build of `buzz-relay`. It runs with `BUZZ_RELAY_PRIVATE_KEY`,
  `RELAY_OWNER_PUBKEY`, `BUZZ_AUTO_MIGRATE=true`, `BUZZ_GIT_CONFORMANCE_PROBE=false` and
  `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`. No MinIO is needed.
- `deps.json` pins `buzz` and `openbot`, as gitignored Docker build contexts.
- Compose adds `buzz-relay` and `redis` under profile `chat`. `pg-init` adds `buzzdb`.
- `start.sh --with-chat` writes `KEY_ENCRYPTION_KEY` and the operator and assistant keys once.

### 10. The Intelligence runner (replaces `durable.ts`)

`src/runtime/intelligence-runner.ts` implements CopilotKit's `AgentRunner` over the interface:
- `run`, `connect`, `isRunning`, `stop`;
- `listThreads`, `getThreadMessages`, `getThreadEvents`, `getThreadState`, `isThreadAccessible`.

It uses no CopilotKit internals, so the runtime's own thread routes work without CopilotKit Intelligence. Delete
`durable.ts`, the `restore()` call and `chat_threads`.

### 11. The OpenBot API subset (`src/openbot/`)

The subset is the one phase 7 recorded (`docs/phase-7-findings.md`). It includes OpenBot's `conversation-events`
WebSocket for live sidebar updates. `getDeployment` answers team edition, with chat, memory and the thread list on and
everything else off. The person is a `member`, with `onboarding: null`. CopilotKit moves to 1.88.0 here, to match the
client.
- **Shapes** follow `api/openapi.yaml` at the pinned commit.
- **Errors** are problem+json; writes honour `Idempotency-Key`.
- **Sign-in** passes through to the application, as today.
- **Organization** `default`.
- **People:** me and preferences; the self-host banner and star nudge are off.
- **Bots:** one Bot, the assistant.
- **Conversations and memory** go through the interface.
- **Telemetry sinks** answer 204.

Everything else answers 501 `NOT_AVAILABLE_IN_THIS_DEPLOYMENT`, and capabilities say so. A contract test validates every
response we send against the spec, and checks that every other route answers 501.

### 12. Dropped: the Intelligence wire protocol

Phase 7 showed that OpenBot's client chats over CopilotKit's local mode, so no Intelligence gateway is built. See
`docs/phase-7-findings.md`.

### 13. Our features in OpenBot's UI

- `open_record`, `open_page` and `open_report` keep the ticket flow, shown as an OpenBot component that frames
  `/chat/open/<ticket>`.
- `propose_move` and `propose_update` appear in OpenBot's approvals view, and are confirmed through
  `/api/actions/<id>/confirm` by the person.
- Proposals move into `chatdb`, so they survive a restart and work across replicas.

### 14. Cut-over

- `/chat/` serves OpenBot's built app (`docker/openbot-app.Dockerfile`).
- `src/client/` is deleted.
- OpenBot's and Buzz's licences ship as a NOTICE.
- Updated alongside: `README.md`, the repository's `CLAUDE.md`, `chat-smoke.sh` and the CI job.

## Rules that do not change

- **Bun 1.4.4 only.** No npm, pnpm or yarn in this repository. `bun check` is the only static check, and no script is
  named `check`.
- **Third-party checkouts** are built by our own Dockerfiles: Buzz with cargo, OpenBot with Bun.
- **Access:** the person's own session is forwarded, and the assistant decides nothing about access.
- **Addresses:** the model never sees an address, and `registry.ts` is the only place a path is written.
- **Writes:** nothing is written to the application without the person's own press.
- **Open source:** no CopilotKit Intelligence, no licence key, telemetry off (`COPILOTKIT_TELEMETRY_DISABLED`,
  `DO_NOT_TRACK`), OpenBot's generative UI off, and no forged entitlement.

## Verification

### Foundation, and kept green

- **Unit tests:** ticket single use, expiry and binding to the person. The registry never returns a page outside the
  person's permissions. The delegate endpoint refuses a bad, expired or replayed assertion.
- **RBAC parity, the test that matters:** on the CRM model, for each of the seven declared roles, every tool result
  equals what that person gets from the product's own API. "Forbidden" and "does not exist" give the same neutral answer.
- **Elsewhere:** `bun run check:all` here and in `common/`, the generator's CI, reporting's `bun run precommit`, and QA
  with `qa-lifecycle-workflows` and `qa-app-with-ai`.

### Added by this plan

| Phase | Check |
|---|---|
| 7 | `docs/phase-7-findings.md`, with the recorded call list from a real browser session |
| 8 and 9 | The conformance suite on the in-memory provider and on a real relay |
| 10 | Runner tests: owner isolation, restart, replay, stop |
| 11 | The contract test against `api/openapi.yaml` |

### End to end

Playwright drives OpenBot's app at `/chat`, in `build-and-run.yml`:
- sign in as `support.agent@…`;
- ask for an account by name and see it open in the frame;
- ask for an entity that role cannot read and get a refusal;
- open a report;
- replay a spent ticket and see it refused;
- reload and find the thread in the list;
- save a memory and recall it in a new thread;
- sign in as somebody else and see none of it;
- turn on chat-only and confirm `/app` and `/report` redirect for that person but not the administrator;
- turn the door off and confirm it closes.

### On the relay

Query it to confirm that messages sit in the private channel, and that a memory is a kind 30174 event and encrypted.

### Before merge

A security review of key custody, the delegate endpoint, the ticket service and chat-only mode.

## Risks and open items

- **The frame's real address is visible in developer tools.** In chat-only mode that address is refused outside the
  chat frame. That is the protection, not secrecy.
- **The local model's tool calling** decides how well natural language works.
- **Several CopilotKit versions coexist:** the generator's, reporting's and this directory's, until the products move.
- **Field-level access** remains unenforced in the generated application; that is separate work.
- **Reporting becomes per-person** when reached through chat. The per-role demo accounts remain for direct sign-in.
- **OpenBot's API is large** (422 operations) and moves. The subset and its 501s are tied to a pin and re-checked
  whenever the pin moves.
- **Buzz calls itself unfinished.** Its rate limiting is a stub and approval gates are not wired; only its core is used
  (events, channels, membership, search, audit).
- **Custodial keys** put every person's Nostr identity in `chatdb`, encrypted. Losing `KEY_ENCRYPTION_KEY` loses them,
  so it is written once and never rotated casually.
