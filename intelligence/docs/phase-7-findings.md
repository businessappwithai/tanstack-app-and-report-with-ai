# Phase 7 findings

These are the spikes run before building anything. They answer the questions `intelligence.md` phase 7 asked. Each
finding was measured in this session, against the pinned checkouts below.

| Project | Commit | How it was run |
|---|---|---|
| `block/buzz` | `b769d5b` | `cargo build -p buzz-relay -p buzz-admin` (debug, Rust 1.98.1 from `rust-toolchain.toml`, 3m48s, no pnpm), relay on local PostgreSQL 16 and Redis |
| `CopilotKit/OpenBot` | `3d8a716` | `bun install --frozen-lockfile` and `bun run build` in `app/` on Bun 1.4.4 (42 s), served by a recording stub, driven in Chromium |

## Buzz

### Running the relay

The relay needs PostgreSQL and Redis, and three settings:
- `BUZZ_RELAY_PRIVATE_KEY`: the relay's own stable key. The relay refuses to start without it.
- `RELAY_OWNER_PUBKEY`: the owner, which is our operator key.
- `BUZZ_AUTO_MIGRATE=true`: applies its 97 migrations at start.

**S3 is not needed to start once `BUZZ_GIT_CONFORMANCE_PROBE=false`.** Without that setting, the relay probes the git
object store in S3 at start and exits when it cannot reach it. We use neither git hosting nor media, so no MinIO is
needed.

The relay is open by default (`BUZZ_REQUIRE_RELAY_MEMBERSHIP=false`), and `BUZZ_REQUIRE_AUTH_TOKEN=false` logs a
warning. Both are set for production in phase 9: membership is required, and only our server's keys are members.

### The relay accepts only kinds it knows

`required_scope_for_kind` in `crates/buzz-relay/src/handlers/ingest.rs` rejects any kind it does not list. The kind
`44100` that the plan proposed for run events is already `KIND_MEMBER_ADDED_NOTIFICATION`, and `44200` is
`KIND_AGENT_TURN_METRIC`. Inventing a kind would mean forking Buzz.

**Run events therefore use NIP-AR artifacts.** NIP-AR (`docs/nips/NIP-AR.md`) is kind `45010`: channel-homed records
with an opaque payload and client-defined tags, readable exactly by the channel's readers.

Each batch of AG-UI events is one create-only artifact:
- `type: appwithai.agui-batch`;
- `run: <runId>` and `seq: <n>` tags;
- the events as JSON in `content`.

The relay accepted one.

### What was proven against the running relay

All writes went through `POST /events` and all reads through `POST /query`, each with NIP-98 HTTP auth from
`nostr-tools`.

| Step | Event | Result |
|---|---|---|
| Operator creates a private stream channel | `9007` with `h`, `name`, `visibility: private`, `channel_type: stream` | accepted |
| Operator adds the person and the assistant | `9000` with `h` and `p` | accepted |
| Person and assistant post | kind `9` with `h` | accepted. The person reads 2 |
| Assistant writes a run batch | `45010` with `ar`, `d`, `h`, `type`, `title`, `op: create`, `run`, `seq` | accepted. The person reads 1 |
| Operator renames the thread | `9002` with `h` and `name` | accepted. Kind `39000` metadata is readable |
| Assistant writes a memory for the person | `30174` (NIP-AE) with `d` (HMAC of the slug) and `p`, NIP-44 content holding `{slug, value, kind, scope, sourceThreadIds}` | accepted. The person decrypts it, extra fields intact |
| An outsider reads messages and artifacts | kinds `9` and `45010`, `#h` | `200 []` |
| An outsider reads the memory | kind `30174` | `403 restricted: agent-engram reads require authors=[self] or #p=[self]` |

NIP-AE (`docs/nips/NIP-AE.md`) publishes test vectors for the `d` tag and the encryption. The provider's tests use them.

## OpenBot

### The app runs against our server, with no Intelligence

The app was served by a stub that answers every operation in `api/openapi.yaml` from its schema. The stub forwards
`/api/copilotkit` to a **CopilotKit 1.88.0 runtime with no Intelligence**: the in-memory runner and a scripted agent.

In Chromium, the app:
- greeted the person;
- listed the Bot;
- opened its chat;
- sent "Find the account Acme";
- drew the agent's reply in OpenBot's own transcript.

The flow was:

```
POST /api/v2/organizations/default/conversation-threads    → createConversationThread (the thread id)
POST /api/copilotkit/agent/default/connect                  → CopilotKit, local mode
POST /api/copilotkit/agent/default/run                      → CopilotKit, local mode
```

**So phase 12, the Intelligence wire protocol, is not needed.**

The client's CopilotKit is 1.88.0, so this directory moves from 1.87.0 to 1.88.0 to match it. The 1.88.0 runtime turns
telemetry on unless `COPILOTKIT_TELEMETRY_DISABLED=true` is set, which our image already sets.

### The deployment answer decides which screens exist

`getDeployment` is the switchboard. Memory is offered only when `edition` is not `personal`
(`app/src/lib/deployment/queries.ts`, `offersMemory`).

The answer that gives chat, memory and the thread list, and nothing we do not serve, is:

```json
{ "edition": "team", "localEvaluation": false, "generativeUi": false, "selfHostBanner": false,
  "transcription": false, "voice": false, "durableHistory": true, "authProviders": [],
  "ssoConfigured": false, "ssoRequired": false, "builtInBots": true, "isolatedBots": false,
  "botComputers": false }
```

The person's answer should carry:
- **`role: "member"`**: administration stays in the application.
- **`onboarding: null`**: nothing to finish.

### The operation subset the core paths call

These were recorded from sign-in, home, the Bot's chat, sending a message, the Bots page and the Memory page.

| Area | Operations |
|---|---|
| Deployment and organization | `getDeployment`, `listOrganizations`, `listInvitations` |
| Person | `getPerson`, `getPreferences`, `getApprovalPreferences`, `getPersonBrowser`, `listBotAttention` |
| Bots | `listBots`, `listBotGrants`, `getModelCatalogue` |
| Conversations | `listConversations`, `createConversationThread`, `listConversationGrants` (plus `getConversation`, `updateConversation`, `deleteConversation`, `listConversationMessages` for rename, archive and history) |
| Memory | `listMemories`, `createMemory`, `updateMemory`, `deleteMemory` |
| Approvals, questions and work | `listApprovals`, `listApprovalRules`, `listPersonApprovalRules`, `getApprovalSettings`, `listQuestions`, `listTasks`, `listCheckIns`, `listCheckInItems` |
| Client tools | `listComponents`, `announceComponents`, `getShortenedToolNames` |
| Sign-in | `/api/auth/get-session` (Better Auth) |
| Realtime | `GET /api/v2/organizations/default/conversation-events`, a WebSocket in `api/asyncapi.yaml`, for live sidebar updates. Chat works without it, but the sidebar does not update live |

That is about 35 of the 422 operations. Every other operation answers 501.

A stub lesson to keep: every nullable field must come back `null`. A `nextCursor` that is a string makes the app page
forever. It made 43,000 calls in one minute.

### Base path

The app assumes it owns `/api` and the site root:
- relative fetches;
- Better Auth's default base;
- `runtimeUrl="/api/copilotkit"`;
- no router basepath.

Under our single nginx origin, `/api/` belongs to the generated application. So the app is built for `/chat/` with an
overlay applied at image build time, in the pattern of `common/build/subpath-overlay.ts`. The overlay covers:
- Vite `base`;
- the router basepath;
- the request prefix in `app/src/lib/api/request.ts` and `lib/client.ts`;
- the auth client's base;
- `runtimeUrl`.

## What changes in the plan

- **Run events** use NIP-AR artifacts (kind `45010`, `type: appwithai.agui-batch`), not an invented kind.
- **Relay settings** add `BUZZ_GIT_CONFORMANCE_PROBE=false` and `BUZZ_RELAY_PRIVATE_KEY`. No MinIO is needed.
- **Phase 12** (the Intelligence gateway) is dropped. OpenBot chats over CopilotKit's local mode.
- **CopilotKit** moves to 1.88.0 here, to match OpenBot's client.
- **The OpenBot subset** is the table above. `conversation-events` (asyncapi) is part of phase 11.
- **The deployment answer** is team edition with the person as a member.
