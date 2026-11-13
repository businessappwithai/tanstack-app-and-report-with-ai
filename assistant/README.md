# Assistant — the chat front door

A chat workspace through which a signed-in person reaches the generated
application (`/app`) and the reporting platform (`/report`) by asking for
things, and works on the real pages inside the chat. Built on the open-source
CopilotKit packages (1.87.0) and nothing else from CopilotKit: no Intelligence,
no cloud, no licence key, telemetry off.

**Status.** The service runs, is tested, and is wired into the orchestrator behind
`./start.sh --with-chat`. It has been run against a real generated application
and the real reporting platform, outside Docker. A composed run has not been
made, and no real language model has been used yet. `../openbotcompat.md` is the
plan and says what is done.

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
| Orchestrator | move both pins once the products' sides are merged; a composed run; `build-and-run.yml` |
| Here | conversations and tickets in the database (both are in memory now, so one replica and lost on restart); create/update/action-button tools with confirmation; rate limits; a run with a real model |

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
| `CHAT_DATABASE_URL` | unset | The audit trail's database, created if missing; in memory without the variable |
