# Assistant — the chat front door

A chat workspace through which a signed-in person reaches the generated
application (`/app`) and the reporting platform (`/report`) by asking for
things, and works on the real pages inside the chat. Built on the open-source
CopilotKit packages (1.87.0) and nothing else from CopilotKit: no Intelligence,
no cloud, no licence key, telemetry off.

**Status: a checkpoint.** The service runs, is tested and has been driven in a
browser against stand-ins for the two products. It is **not yet wired into
`docker-compose.yml`, nginx or `start.sh`**, and the two products do not yet
have the pieces it needs from them (below). `../openbotcompat.md` is the plan.

## What holds today

- **Identity is the application's.** The assistant reads the generated
  application's session cookie (same origin) and forwards it on every call. It
  has no accounts, roles or passwords of its own; the application's guards
  decide everything.
- **The model never sees or writes an address.** Tools return an *intent*
  (`product`, `kind`, `object`, `id`); `src/server/registry.ts` is the only
  place a path is written, after the product confirmed the person may read the
  target.
- **The chat holds a ticket, not a URL.** `src/server/tickets.ts`: 256 random
  bits, single use, 60 seconds, bound to the person. The frame loads
  `/chat/open/<ticket>` and is redirected.
- **"Forbidden" and "does not exist" are one answer.**
- **Every tool call is audited** (tool, target, outcome — never contents).
- **Conversations belong to whoever started them** (CopilotKit's `identifyUser`).

## Still to do

| Where | What |
|---|---|
| Reporting platform | `POST /api/auth/delegate`, `GET /api/search`, embed mode, frame headers |
| Generated application | embed mode, the two switches (`CHAT_ENABLED`, `CHAT_ONLY_MODE`) in `/api/sys/app-info`, the chat-only redirect |
| Orchestrator | compose service, nginx `location /chat/`, `start.sh --with-chat`, landing page, CI |
| Here | conversations and tickets in the assistant's database (both are in memory now, so one replica and lost on restart); create/update/action-button tools with confirmation; rate limits |

## Run it

```bash
bun install                 # Bun 1.4.4
bun run check:all           # type-check (bun check) and tests
bun run build
bun scripts/preview.ts      # http://localhost:4300/chat/ with stand-in products and model
```

`scripts/preview.ts` signs any e-mail and password in as the Support Agent and
plays a three-step script (search, open, answer); it shows the interface, not a
model's judgement.

## Configuration

| Variable | Default | |
|---|---|---|
| `CHAT_BASE_PATH` | `/chat` | Build-time and run-time; the prefix everything is served under |
| `APP_API_URL` | `http://127.0.0.1:4001` | The generated backend, reached directly |
| `REPORT_URL` | `http://127.0.0.1:3000` | The reporting platform, reached directly |
| `CHAT_BRIDGE_SECRET` | required in production | Shared with both products; signs delegation and the embed cookie. Generate once |
| `PUBLIC_ORIGIN` | `http://localhost` | The origin a browser sees |
| `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` | the local endpoint | Any OpenAI-compatible endpoint whose model supports tool calling |
| `CHAT_DATABASE_URL` | unset | The audit trail's database; in memory without it |
