# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

---

## What this repository is

An **orchestrator**. It holds the modelling language two products read, and the
pieces that compose those products into one running system. It does not hold
either product.

| | What it is | Where |
|---|---|---|
| **This repository** | EML — the language, checker, fixer, composer and `eml` CLI — plus the reporting-pack and subpath-overlay builds, the seeder, the Docker pieces, the published guide and the model viewers | [`common/`](common/) |
| **APPWITHAI** | An AI-assisted ERD designer and full-stack code generator. One Mermaid document describes the data, the decisions and the processes; the generator compiles all three into a running NestJS + TanStack Start application | `businessappwithai/app-with-ai-tanstack` |
| **Enterprise Reporting** | A multi-datasource analytics platform: connect external databases, ask questions in natural language, and publish the answers as reports, charts, dashboards and scheduled deliveries | `businessappwithai/enterprise_reporting_tanstack` |

The two products were subfolders here until recently. They are now separate
repositories with their own CI, their own release cadence and their own
lockfiles, checked out on demand:

```
check the model            common/language/checker.ts
      ↓
generate the application   --stack tanstack-nestjs, driving the orchestrator
      ↓                    inside app-with-ai-tanstack
put it on /app             common/build/subpath-overlay.ts
      ↓
derive the reporting pack  common/build/reporting-pack.ts — a CLI over the
      ↓                    generator's buildReportingPack: the queries, and one
      ↓                    reporting role per %%rbac role
write the front door       common/build/landing.ts — both applications, both
      ↓                    sets of accounts, served by nginx at /
inject configuration       common/.runtime/.env
      ↓
build and start            docker compose — postgres, the generated backend and
      ↓                    front end, the reporting platform, the seeder that
      ↓                    loads one into the other, nginx in front
smoke-test                 /app and /report answer, and the seeder finished
```

---

## Bun 1.4.4, and only Bun 1.4.4

**Every repository in this project uses Bun 1.4.4 and no other version** —
`app-with-ai-tanstack`, `app-and-report-with-ai-tanstack`,
`enterprise_reporting_tanstack` and `businessappwithai.github.io`. That is the
rule for every runtime, install, build, test and type-check, in CI, in Docker
images and locally. There are no exceptions: the WASM build and the
`appwithai-wasm` CLI run on 1.4.4 too (the second 1.3.11 pin they used to have
is gone).

- **Never use another Bun.** Not 1.3, not 1.4.0–1.4.3, not a newer release. Bun's
  bundler output depends on the exact version, so a committed bundle built on
  another one is byte-wrong for CI; and a Bun older than 1.4.3 has no type
  checker behind `bun check` at all.
- **The static check is `bun check`, and only `bun check`.** There is no linter
  or formatter, and nothing runs `tsc` as the type checker.
- **No `package.json` may have a script named `check`.** On 1.4.4 as on every
  earlier Bun, `bun check` in a directory whose manifest has a `check` script runs
  that script instead of the type checker, silently. This repository's aggregate
  used to be called `check` — which is why `type-check` once had to `cd ..` to
  reach the real checker. It is `check:all` now.
- **Never use npm, pnpm or yarn** as the package manager.
- **Pin it exactly** wherever a version is stated: `BUN_VERSION: "1.4.4"` in CI,
  `oven/bun:1.4.4` in Dockerfiles, `"bun": ">=1.4.4"` in `engines`, `1.4.4` in
  `.bun-version`. Moving to a different Bun is one deliberate change made in all
  four repositories together, never in one alone.
- **What a generated application runs on is a separate question.** The browser
  (WASM) application the generator writes is Bun-free by design — its overlay
  swaps bun for node — and that is about the *output*, not the toolchain that
  produced it.

**Here:** `BUN_VERSION` in `root-ci.yml` (one pin, for every job — the WASM
CLI's job included) and `build-and-run.yml`, the `report` and `seeder` images,
`engines` in `common/package.json` and `common/language/cli/package.json`, and
`.bun-version`, which the `SessionStart` hook installs. If `bun --version` prints
anything else, install 1.4.4 before believing any check: the bundle `--check`
steps name the mismatch.

---

## `deps.json` — the pins, and the only place they live

`deps.json` names the commit of each product repository that this one is known
to work with. **Nothing else names a ref.** `./deps.sh` reads it to place the
checkouts locally; every workflow reads it in a `resolve` job and feeds the
result to `actions/checkout`. A local tree and a runner therefore check out
identically, and moving a pin is one edit.

```bash
./deps.sh                # clone or update both to their pinned refs
./deps.sh --install      # …and bun install --frozen-lockfile where deps.json asks
./deps.sh --status       # what is checked out, and whether it matches
./deps.sh --update       # resolve each branch to its head and rewrite deps.json
```

The checkouts land at `app-with-ai-tanstack/` and
`enterprise_reporting_tanstack/` beside `common/`, and are **gitignored**. They
are not vendored code and not submodules — treat them as read-only working
copies of someone else's repository. `--update` refuses to move a checkout that
has uncommitted changes, because the likeliest reason for them is that someone
is debugging across the boundary.

**Moving a pin is a deliberate step, taken by running the checks:**

```bash
./deps.sh --update && ./deps.sh --install && cd common && bun run check:all
```

### Why the checkouts are needed, precisely

Two modules under `common/language/cli` reach into `app-with-ai-tanstack` on
purpose, so that the CLI and the modelling tool cannot disagree about what a
rule flow compiles to:

| Reaches for | From | Consequence when absent |
|---|---|---|
| `packages/web/src/lib/jdm-converter.ts`, `packages/editors/src/lib/mermaid-flowchart-parser.ts` | `language/cli/src/generate/jdm.ts`, as a static import | **Every** `--stack` target fails at module resolution, and `tsc` reports TS2307. `jdm.ts` sits on every generation path — this is not just the heavy target |
| `packages/generator/src/pipeline/generate-application.ts` | `language/cli/src/generate/tanstack.ts`, resolved at runtime | `--stack tanstack-nestjs` cannot generate |

Nothing type-checks either path — one imports across a repository boundary, the
other resolves from a non-literal specifier — so moving either file breaks
generation and nothing else. Running the generator is the only way to notice,
which is what `check:stacks` is for.

`tanstack-nestjs` additionally needs `app-with-ai-tanstack`'s **own**
dependencies installed: with a `node_modules` under `common/` and none there,
resolution stops here and the generate fails on `Cannot find package 'zod'`.
That is why `./deps.sh --install` exists and why `start.sh` refuses to run
without it.

**`--install` installs one checkout, not both.** `deps.json` carries an `install`
flag per dependency and only `app-with-ai-tanstack` sets it: nothing local reads
`enterprise_reporting_tanstack`'s `node_modules`, because that checkout is a Docker
build context and the image build runs its own install inside the image. A run that
prints `no install needed (see deps.json)` for it is behaving correctly.

A third module joins them, and it is the one that carries the most weight:

| Reaches for | From | Consequence when absent |
|---|---|---|
| `packages/generator/src/reporting/pack.ts` | `build/reporting-pack.ts`, as a static import | No pack can be derived at all — `bun run pack`, `check:pack` and `start.sh`'s fourth step all fail at module resolution |

**The pack derivation moved to the generator.** It was about eight hundred lines
in `build/reporting-pack.ts`; that file is now a 165-line CLI over
`buildReportingPack`. The move happened because the pack acquired two more
readers: a generated application's browser build serves the same reports behind
its own sign-in, and its deployable archive ships the pack in a `reporting/`
directory for the platform its compose file starts. Three derivations would have
been three answers to "what reports does this model have", and the first time
any of them changed the products would have disagreed about a model in front of
a reader. The direction is the point — the generator writes the applications, so
it owns what a model means.

What stayed here is what belongs to this repository: the CLI, the diagnostics
gate (on *this* repository's `parseEml`, the checker `check:models` runs), and
compose's idea of where a pack goes. `tsconfig.language.json` gained a `paths`
entry for `@appwithai/core/*` so the checkout's own aliases resolve; without it
the type-check reports TS2307 on the generator's type imports and a cascade of implicit
`any` behind them.

`enterprise_reporting_tanstack` is needed at a different moment — it is the
Docker build context for the `report` and `seeder` services. **The seeder is now
that project's own script**, `scripts/seed-reporting-pack.ts`, rather than
`common/seed/seed-reporting.ts` copied into its tree at image build time: it
needs that project's real `getDb`, `encrypt` and `introspectAndCacheSchema`, it
writes eleven of that schema's tables, and a generated application's compose
file runs the same script. `common/seed/` is gone and `seeder.Dockerfile` no
longer takes the `common` build context.

---

## Layout

```
.
├── deps.json             ⭐ the two product repositories, and the commit of each
├── deps.sh               place them locally  (wraps common/scripts/deps.ts)
├── start.sh              generate an application and bring both up
├── stop.sh               --volumes discards the databases too
├── docker-compose.yml    profiles: demo (one PostgreSQL) · prod (two)
├── .github/workflows/
│   ├── root-ci.yml       models · types · stacks · both CLIs · reporting pack
│   └── build-and-run.yml the orchestrator: generate → configure → build → run → smoke-test
├── common/               everything that is not a product
│   ├── package.json          the only manifest; `bun run check:all` lives here
│   ├── tsconfig.language.json  strict; covers language/, build/, scripts/
│   ├── language/         EML — definition, spec, grammar, checker, fixer, composer, CLI
│   │   ├── appwithai-language.json   ⭐ the canonical machine-readable definition
│   │   ├── checker.ts · fixer.ts · composer.ts · rag.ts · index.ts
│   │   ├── grammar/appwithai.ebnf
│   │   ├── spec/         00-overview · 01-erd · 02-business-rules · 03-workflows
│   │   │                 04-types-and-modifiers · 05-directives
│   │   ├── cli/          eml.ts, and src/generate/{app,tanstack,enterprise-reporting,jdm}.ts
│   │   └── examples/     crm · dance-studio · ecommerce · helpdesk · minimal
│   ├── build/            reporting-pack.ts (a CLI over the generator's
│   │                     buildReportingPack) · subpath-overlay.ts · landing.ts
│   ├── docker/           reporting.Dockerfile · seeder.Dockerfile · nginx · pg-init
│   ├── scripts/          deps.ts · check-models.ts · check-stacks.ts · check-reporting-pack.ts
│   ├── html/             the published nine-chapter guide, checker.js, fixer.js, wasm-app
│   │                     — the two validators are BUILT here, not vendored (below)
│   ├── website/
│   │   ├── llmtext/      llms.txt (controller) + 6 chunks · llms-reporting.txt
│   │   └── viewers/      the ERD, rules and workflow model viewers
│   └── examples/         analytics-reporting · drug-discovery · investment-planning · ERD sketches
│
├── app-with-ai-tanstack/            ← placed by ./deps.sh, gitignored
└── enterprise_reporting_tanstack/   ← placed by ./deps.sh, gitignored
```

**Everything runs from `common/`.** There is no manifest, lockfile or
`node_modules` at the repository root; `bun install` and every `bun run` belong
inside `common/`. The scripts resolve their own paths from `import.meta.dir`.

---

## Commands

```bash
./deps.sh --install      # first, always — the checks need the checkouts

cd common
bun install

bun run check:all        # models → types → validators → stacks → CLIs → pack
bun run check:models     # every model checks clean, and the duplicated copies match
bun run type-check       # bun check over tsconfig.language.json — see below
bun run build:language-tools        # bundle html/checker.js and html/fixer.js
bun run check:language-tools        # …and fail if the committed copies are stale
bun run check:stacks     # every --stack target actually generates
bun run check:clis       # both published CLIs generate — see below
bun run check:cli        # just `appwithai`
bun run check:cli:wasm   # just `appwithai-wasm`
bun run check:pack       # every derived query runs against a real generated schema
bun run check:pack:ci    # same, but --require-server: a missing database fails
bun run pack             # bun build/reporting-pack.ts
bun run vendor:guide     # PGlite, the WebContainer API and the stack templates
                         #   beside html/ — the run pages never fetch them from a CDN
```

Individual pieces:

```bash
bun language/checker.ts examples/analytics-reporting.eml.mmd
bun language/fixer.ts <model.eml.mmd>              # applies the auto-fixable codes in place

bun language/cli/eml.ts validate -i <model>
bun language/cli/eml.ts info -i <model>
bun language/cli/eml.ts generate -i <model> -o ./out --stack node-rest

bun scripts/check-stacks.ts --skip-heavy           # skips tanstack-nestjs only
CHECK_STACKS_MODEL=language/examples/crm.eml.mmd bun scripts/check-stacks.ts
```

`eml` flags: `-i/--input`, `-o/--output`, `-n/--name`, `--stack`, `--docker`,
`--github <owner/repo>`, `--github-token`, `--private`/`--public`,
`--no-autofix`, `--force`, `--json`, `-h/--help`, `-v/--version`.

### Install first — the failure modes are silent

With no `node_modules` under `common/`, `bun check` reports thousands of phantom
errors: every `node:` builtin and every `process` is unresolvable. The manifest
carries `@types/node` and `@types/bun` mostly for this reason. Install before
you believe any type-check result.

With no dependency checkout, the type-check reports **four** errors in
`language/cli/src/generate/jdm.ts` and every stack target fails. That is a
missing `./deps.sh`, not a broken repository.

### Use bun, never npm or pnpm

Bun is the runtime, the package manager and the test runner. Everything runs
on **Bun 1.4.4** — CI's `BUN_VERSION`, the `report` and `seeder` images, the
nightly build, and both CLIs. The manifest's floor is `>=1.4.4`.

The `appwithai-wasm` CLI used to be the exception, checked on a second pin
(`BUN_VERSION_WASM: "1.3.11"`). `app-with-ai-tanstack` requires 1.4.4 in every
manifest — the generator that ships that CLI included — and builds and tests its
WASM stack on 1.4.4, so the second pin was proving the CLI on a runtime its own
package no longer supports. It is gone. What the WASM path *generates* is still
Bun-free: the overlay swaps bun for node in the application it writes, and that
has nothing to do with the bun the CLI itself runs on.

### There is no linter or formatter — the static check is `bun check`

Biome is gone: `language/biome.json`, the dependency, the `lint` scripts and the
CI step. Bun has no linter, so nothing checks style; keep the existing style by
hand (2 spaces, double quotes, semicolons, 100 columns). The static check is
**`bun check`**, the type checker built into Bun since 1.4.3: same errors as `tsc`,
about 0.2 seconds over the 73 files `tsconfig.language.json` covers.

**`type-check` is `bun check -p tsconfig.language.json`, run inside `common/`.**
It used to run from the repository root, because inside `common/` `bun check`
meant *this package's own `check` script* — Bun runs a package script of that
name in preference to the built-in, so it quietly ran models, stacks, CLIs and
pack instead of type-checking. The aggregate is `check:all` now and nothing
shadows the checker. On a Bun older than 1.4.3 it fails with "Script not found"
rather than passing. `typescript` stays a dependency for editors; nothing in a
script runs `tsc`.

---

## One protocol document

`common/website/llmtext/llms.txt` is the document a language model is pointed at,
and it is a copy of `app-with-ai-tanstack`'s `website/llmtext/llms.txt`. It is one
working-session protocol for both jobs: given a description of a business it builds
a new model, given a `.mmd` it changes that file in place, hands back the whole of
it and proves nothing was lost. It asks the user's pace first — walk through it
one decision at a time, or just build it — and it requires a complete
Application Dictionary: help on every entity and column, the `FK` modifier and an
enum binding wherever they apply, and **every form laid out as `%%section` rows**.

`llms.txt` is a ~1k-token controller; the detail lives in six chunks it names (`working-session`, `eml-syntax`,
`eml-dictionary`, `eml-reporting`, `checker-rules`, `enhancement-examples`, each `.txt`), which a model fetches only
when a step needs them. All seven are byte copies, held to the pinned upstream by `bun run check:protocol`. GitHub
Pages types `.md` as `text/markdown`, which ChatGPT's web reader refuses, so there is no `llms.md`. Copy them from
upstream, never edit them here.

There is no other protocol file: the four older documents and `llms.md` are deleted, so a model is
never pointed at a second account of the language. **Edit `llms.txt` upstream and copy it**, never
here. Nothing in this repository checks it; the assertions are upstream in `bun run test:llmtext` and
on the site in `scripts/check-spec.mjs`.

**Nine codes are dictionary-completeness gaps, not advice**: `EML119`, `EML146`,
`EML151`–`EML154`, and the form-layout trio `EML170` (an entity with no
`%%section`), `EML172` (a column no row places) and `EML177` (a section with no
help). They are warnings because the generator does not refuse them, and
`audit-model.mjs` fails a model carrying any. `language/sections.ts` is the one
reading of `%%section`, shared by the checker and the fixer (which repairs
`EML172`, `EML174` and `EML175`); the generator has its own parser upstream.

**The browser entries are the product's, copied.** `language/browser/checker.entry.ts`
and `fixer.entry.ts` are byte-for-byte upstream's, so `html/checker.js` carries
`lineText` on every placeable diagnostic and names the nine dictionary-completeness
codes apart from the advisory warnings in its closing line — the verdict a language
model reads last. The two bundles differ from the site's only in the language
definition each inlines (this repository's canonical copy). When upstream changes
an entry, copy it and run `bun run build:language-tools`.

### The published host is written in full

Every mention of the host in `llmtext/llms.txt` is
`https://www.appwithai.org` — scheme and `www.` included. **`www` is canonical
and the apex serves the same files**; both carry a certificate. For part of this
project's life `www` was a DNS record onto the apex, so GitHub Pages served it a
certificate naming only the apex and every client refused it with
ERR_CERT_COMMON_NAME_INVALID — which is why these documents named the apex for a
while. It is a CNAME onto `businessappwithai.github.io` now. These copies used the
apex for most of their URLs and named the host without a scheme in prose, and a
model following them reported a failed validator fetch as a Markdown link around
a bare host, which is what its own tooling then tried to resolve. Nothing in this
repository checks it; the assertions are upstream in `bun run test:llmtext` and
on the site in `scripts/check-spec.mjs`, each against its own copies.

## The language

`common/language/appwithai-language.json` is the **single source of truth** —
type vocabulary, modifiers, cardinalities, hook types, rule-node shape
semantics, directives, grammar and the generator contract. Everything else in
`language/` documents or loads it. Load it through the typed accessor in
`language/index.ts` (`loadLanguageDefinition`, `normalizeType`,
`cardinalityKind`, `isHookType`), never by reading the JSON directly.

Each product repository carries its own copy for its own CI —
`app-with-ai-tanstack/language/` and, under the older name
`erdwithai-language.json`, `enterprise_reporting_tanstack/language/`. All three
have drifted from each other — at the pinned commits, 90 normalized JSON lines
against app-with-ai-tanstack's and 200 against the reporting platform's.
**When any of them disagrees with the copy here, the copy here is the language.**

**All three declare `"version": "1.2.0"`.** The version cannot tell you which
copy you are holding, and nothing checks one against another, so drift is silent
in both directions: a change made here does not reach either product, and a
change made in one does not reach here. `check:models` compares
`language/examples/` against `html/models/` — a different pair, and the likeliest
reason to believe a cross-repository check exists when none does.

Every EML document is valid, renderable Mermaid. EML is a *semantic superset*:
it assigns generator meaning to `erDiagram`, `flowchart` and `stateDiagram-v2`,
and to renderer-safe `%%` directive comments.

**Directives may be indented.** `language/cli/src/parser.ts` trims each line
before testing `startsWith("%%")`, and the reference models indent their
directives four spaces to sit inside the diagram block they annotate. Grepping
for `^%%` therefore undercounts badly — `crm.eml.mmd` answers 0 to `^%%report`
and 33 to `%%report`. Search without the anchor.

### The three `--stack` targets

| `--stack` | Emits | Standalone |
|---|---|---|
| `node-rest` *(default)* | A dependency-free `node:http` app over a JSON-file datastore | Yes — `npm start`, no install |
| `tanstack-nestjs` | The full stack: NestJS + Fastify + Kysely backend, TanStack Start front end, migrations, seeds, dictionary, manual (~356 files). Drives the shipped orchestrator | Yes |
| `enterprise-reporting` | TanStack Start server functions (`.inputValidator()`), list/detail routes (shadcn/ui + TanStack Table), a Kysely PostgreSQL migration, a `Database`-interface snippet | **No** — code to drop into an `enterprise_reporting_tanstack` checkout |

They differ in what they write, never in what they understand: all three read
the same parsed model. `enterprise-reporting` reaches least on purpose — that
platform already has auth, two layers of RBAC, an encrypted connection manager,
an NL→SQL pipeline, a job runner and a UI shell, so the target emits only what a
new entity needs. It does **not** compile workflows or `%%rbac`. See
`language/README.md` for the coverage table.

**All three carry optimistic locking, the same contract the product's stacks
do.** Every record has a `version` the application raises on each save; a save
naming an older one is refused with `VERSION_CONFLICT` instead of overwriting
somebody else's change. `node-rest` speaks it over HTTP — `ETag` on a read,
`If-Match` on `PUT`, 409 with `details.code` — in
`language/cli/runtime/src/{services,server}.js`; `enterprise-reporting` emits a
`version` column, an update server function whose `UPDATE … WHERE version = …`
refuses a stale save, and a detail page offering Reload their version /
Overwrite with mine / Keep editing; `tanstack-nestjs` gets it from the product.
`applicationDictionary.optimisticLocking` in `appwithai-language.json` and §5.4.1
of `llms.txt` describe it. The runtime under
`language/cli/runtime/` is byte-identical to the product's and to the reporting
platform's — change all three or none.

---

## Conventions that bite

**Two CLIs, one runtime.** `appwithai` and `appwithai-wasm` both run on bun
**1.4** — what `app-with-ai-tanstack` requires. `root-ci.yml` still gives them a
job each (`stacks` and `wasm-cli`) so they run side by side; the WASM one is
worth its own job because its overlay — WebAssembly PostgreSQL for `pg`, node for
bun in the generated application — is a stage nothing else reaches.
`check:clis` prints the bun each result came from.

**Models are checked in twice.** `language/examples/*.eml.mmd` and
`html/models/*.eml.mmd` are the same files: one set is what the CLI reads, the
other is what the published guide serves. `check:models` asserts they are
byte-identical. **Edit both.** `common/examples/` carries no such constraint.

**The checker writes a `.error` file beside every model it reads.** That is its
interface, not an accident. `check-models.ts` removes any it created that git
does not already track, so a passing run leaves the tree clean;
`examples/hospital-management-system.mmd.error` is committed on purpose and
escapes `.gitignore`'s `*.eml.mmd.error` rule by not matching it.

**The published validators are built here, and that is a change.** `html/checker.js`
and `html/fixer.js` used to be copied from `app-with-ai-tanstack`'s `html/`. They are
bundled now, by `bun run build:language-tools`, from `language/browser/*.entry.ts` —
and each one **inlines `language/appwithai-language.json`**, the copy this repository
calls canonical.

That is the whole reason for the change. A vendored checker embeds the *product's*
language definition, so this repository was publishing a validator that disagreed with
the language it ships beside — by exactly the deltas kept on purpose. The difference is
visible: the vendored bundle contains no `repositoryLayout` and no `enterprise-reporting`,
the built one contains both.

Two things make it easy to get wrong:

- **`Bun.build` output depends on the bun version *and* the platform.** `root-ci.yml`
  pins `BUN_VERSION: 1.4.4` and runs on `linux-x64`; a bundle built on anything else is
  byte-wrong for CI while looking right locally. `scripts/lib/build-env.ts` reads that
  pin out of the workflow and says which case a mismatch is, rather than "out of date"
  — which is true of a stale build and misleading about a foreign one. The branch this
  arrived on had been built on an older bun: it passed `--check` on its author's
  machine and failed on CI's runtime.
- **`check:language-tools` is a CI step of its own.** The `language` job does not run
  `bun run check:all` — it runs `check:models` and `type-check` separately — so
  adding a check to that script alone would never run in CI.

`website/viewers/eml-model.js` is **not** built here and stays vendored: its entry lives
in the `app-with-ai-tanstack` checkout and imports *that* repository's language copy.

**CI fails on a dirty tree.** The `language` job runs `git status --porcelain`
after the checks and fails on any tracked modification. A check that rewrites a
file it read is a bug in the check. The dependency checkouts are gitignored, so
they cannot trip it.

**`check:pack` looks for PostgreSQL on the Unix socket by default.** A server
listening only on TCP — the usual case in a container — reads as "no PostgreSQL",
and the check skips. Point it there to run it:

```bash
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=… \
  bun scripts/check-reporting-pack.ts --require-server
```

**`check:pack` skips itself when no PostgreSQL is reachable** and says so. CI
passes `--require-server` so a database that never came up fails instead: a
check that quietly passes without running is indistinguishable from one that
ran, and the whole point of that file is to not be that.

---

## Running the two applications together

```bash
./deps.sh --install
./start.sh                                     # the reference CRM model
./start.sh common/examples/my-app.eml.mmd      # any other model
./start.sh my-app.eml.mmd --profile prod       # two database servers
./start.sh --port 8080                         # somewhere other than :80
```

| | |
|---|---|
| http://localhost/ | the front door: both applications and the accounts for each |
| http://localhost/app | the application generated from the model |
| http://localhost/report | the reporting platform, already holding that application's schema as a data source and its reports, charts and dashboard |

The first start migrates and seeds the application, then loads its schema and
reporting pack into the platform; until the seeder exits, `/report` is up but
**empty**. `./stop.sh` takes it down, `--volumes` discards the databases too.

### Two applications, two logins, and why they are not merged

This is the thing most likely to be got wrong, so the root serves a page about
it rather than redirecting. `/` used to `return 302 /app/` under a comment
saying "guessing which one somebody meant is worse than saying so" — and then
guessing. A reader who did not scroll back through the terminal never learned
`/report` existed, so the platform that had just been built and attached to
their application was invisible.

|  | `/app` | `/report` |
|---|---|---|
| Database | `appdb` | `enterprise_config` |
| Users | its own table, its own session | its own table, its own session |
| A role decides | what you may **do** to a record | which tables your queries may **read** |
| `sales_manager` | `sales.manager@<app>.example.com` | `sales.manager@<app>.reports.example.com` |

`reporting-pack.ts` derives the second column from the *same* `%%rbac` the
application compiles, so the two role sets line up by name — one reporting role
per declared role, permitted to read exactly the `bus_` tables that role's
`read` rules admit. **It is a mirror, not a shared system**: nothing is
federated, neither password works on the other side, and merging them would
force one product's meaning of "role" onto the other.

Two details worth knowing:

- **The addresses differ on purpose.** Identical ones would invite a reader to
  try a single password on both. The administrator is the exception and keeps
  `admin@admin.com` on each side — the same address, two different accounts, in
  two different databases — because that is what the platform bootstraps for
  itself. Every seeded account uses the password `admin`.
- **Only `read` rules narrow a reporting role.** `%%rbac` also restricts create,
  update and delete, and none of that means anything to somebody who cannot
  write through the reporting platform at all.

Both sides of that mirror are now *served* as well as seeded: the generated
application's browser build carries the same reports and the same roles behind a
sign-in of its own, and its deployable archive brings the real platform up
beside it. One derivation feeds all three.

**What each surface runs, and what it may claim.** The orchestrator and the
deployable archive both build `enterprise_reporting_tanstack` from its own
source and change nothing a reader sees — here `subpath-overlay.ts` rewrites
only URLs so it can live under `/report`, in the build container's copy; the
archive clones it at `REPORT_REF` and builds it as is. The browser build cannot
run a server, so its reporting app is a **preview drawn in the platform's own
layout and tokens**, labelled as one on every screen, with a working
Administration (users, roles, per-role table grants, the data source, an
activity log) and a page naming where the real one is for every screen that
needs the platform's servers. It lives in `app-with-ai-tanstack`, under
`packages/generator/templates/wasm/ui/views/{er-kit,report-app,report-admin}.js`.

The table counts on the front door are asserted against `deriveAccess`'s own
`entityCounts` before the pack is written — two readings of one fact is how the
products come to disagree about what a role may see, so the second is checked
against the first rather than merely resembling it.

`start.sh`'s six steps: check the model → generate into `common/.runtime/app` →
overlay onto `/app` → derive the pack into `common/.runtime/pack` → write
`common/.runtime/.env` → `docker compose up`. Everything it writes stays under
`common/.runtime/`, which is gitignored. **Neither product checkout is
modified.**

**Secrets are generated once and then left alone.** Regenerating
`ENCRYPTION_KEY` leaves every stored data-source password undecryptable, and the
failure looks like a broken data source rather than a rotated key. Writing
`common/.runtime/.env` *before* running `start.sh` is therefore the supported
way to inject configuration — it keeps what it finds and rewrites only the block
it derives from the run. `build-and-run.yml` uses exactly that.

### The two profiles

- **`demo`** (default) — one `apache/age:PG16` holding three databases: the
  application's, `enterprise_config`, and `ers_knowledge`.
- **`prod`** — two servers, each the image its application asks for:
  `pgvector/pgvector:pg18` for the generated application, `apache/age:PG16` for
  the platform.

Under both, the platform's configuration never shares a database with the
application it reports on: regenerating the application drops and recreates its
tables, and the reports have to survive that.

**No service declares `depends_on` for a database.** A `depends_on` naming a
service outside the active profile makes compose refuse to start at all, so
anything that must run under both profiles cannot name either database. Each
waits for its own: the generated backend migrates on start and is restarted
until that succeeds, the platform bootstraps its schema on first request, and
the seeder waits for both — including for the application's `bus_` tables to
exist, since an empty database means "not migrated yet" rather than "nothing to
report on".

**Neither prefix is stripped by nginx.** Both applications are *built* to live
under their prefix — bundler `base`, router `basepath`, static lookup — so an
incoming `/report/dashboard` is the path the router expects to match. Stripping
would give the server `/dashboard` while every link it writes says
`/report/dashboard`, and navigation would break on the first click. nginx
addresses every upstream through a variable with `resolver 127.0.0.11`, so an
application that is not up yet answers 502 instead of refusing to start the
whole origin.

### Where the reports come from

`buildReportingPack` invents nothing — it lives in the generator
(`packages/generator/src/reporting/pack.ts`) and `build/reporting-pack.ts` is
the CLI over it. Every query is derived from something the model declares:

| Model declares | Pack gets |
|---|---|
| an entity | a register — what rows exist, newest first |
| an `%%enum`-bound column | a breakdown, as a chart |
| `created_at` | volume by month, as a line |
| a `kind: state` workflow | a lifecycle over the states the diagram declares, in its order, zeroes included |
| numeric columns | a measures report, grouped by the entity's primary enum column |
| `oneToMany` | children per parent, ranked |

Names and descriptions come from `%%entity help:` and `%%field help:` — the only
place a model says what an entity is *for* rather than what shape it is. That is
the difference between a report called "bus_account by status" and one called
"Accounts by status" that explains what an account is in this business. A model
with no help text still produces a working pack; it just produces one named
after tables.

**The same table is in the language and in every protocol document now.**
`generatorContract.reportingApplication` in `common/language/appwithai-language.json`
and the reporting-application section of `llms.txt` describe the pack, the three surfaces
that serve it and the two sign-ins, and its enhancement path follows an edit into it. Change `pack.ts` and those change
with it.

A model can also carry `%%report` directives — a question its users actually
ask, written as the SQL that answers it. Those are listed first and take the top
of the dashboard. See `website/llmtext/llms.txt`.

---

### What the website takes, and from where

The site (`businessappwithai.github.io`) vendors from **`app-with-ai-tanstack`**,
not from this repository and not from `enterprise_reporting_tanstack`: the
checker, fixer, both browser generators, the stack templates and the viewers'
reader (its `CLAUDE.md` lists them). The reporting preview reaches the site
inside `appwithai-wasm.js`, drawn in the platform's own shell. So after moving
the pins here, bringing the site level means re-vendoring those files from the
`app-with-ai-tanstack` commit this repository now pins, then running the site's
`website-e2e.mjs`.

## CI

| Workflow | Trigger | What it does |
|---|---|---|
| `root-ci.yml` | push to `main`, PRs touching `common/**`, `deps.json`, the scripts or compose file | `resolve` reads the pins, then four jobs: models/types, every stack plus the `appwithai` CLI, the `appwithai-wasm` CLI, and the reporting pack against a real `postgres:16` |
| `build-and-run.yml` | `workflow_dispatch`, nightly at 04:00 UTC | The whole thing: check out both products at their pins, generate an application from a model, inject configuration, `docker compose up`, wait for `/app` and `/report` to answer, assert the seeder exited 0, report what the platform was loaded with, upload logs and the generated source, tear down |

Both start with a `resolve` job that reads `deps.json` and emits the repository
and ref for each product as job outputs. **No workflow restates a ref in a
`with:` block** — that is how pins drift.

`build-and-run.yml` takes `model`, `profile`, `app_ref` and `report_ref` inputs;
the two refs override `deps.json` for a one-off run, so a branch of the
generator can be tried against the pinned platform without committing anything.
Every run prints the three commits it actually used in its summary.

`reporting-pack` is the only check that runs the derived SQL against the schema
the generator actually emits. The pack is built from a parsed model while the
tables come from a separate compiler in another repository, and nothing
type-checks one against the other — a column the generator renames leaves the
pack building cleanly and every report failing at run time. It caught exactly
that on its first run.

A path-filtered run that is skipped reports no status at all, so if any of these
are made required checks they need a skip-path fallback.

---

## Git workflow

1. Branch from `main`.
2. `./deps.sh --install`, then `cd common && bun install`. Neither check means
   anything without both.
3. Run `bun run check:all` before pushing — or at minimum `check:models` and
   `type-check`.
4. If you touched a model under `language/examples/`, update its twin under
   `html/models/`.
5. If you moved a pin in `deps.json`, say in the commit message what moved and
   why, and confirm the checks passed against the new commit.
6. Target `main` for PRs.
