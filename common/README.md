# app-and-report-with-ai-tanstack

Two products and one modelling language. This repository is the **orchestrator**:
it holds the language, and the pieces that compose the two products into one
running system. It does not hold either product — both are separate
repositories, checked out on demand at the commits `../deps.json` pins.

| | What it is | Repository |
|---|---|---|
| **APPWITHAI** | An AI-assisted ERD designer and full-stack code generator. One Mermaid document describes the data, the decisions and the processes; the generator compiles all three into a running NestJS + TanStack Start application | [businessappwithai/app-with-ai-tanstack](https://github.com/businessappwithai/app-with-ai-tanstack) |
| **Enterprise Reporting** | A multi-datasource analytics platform: connect external databases, ask questions in natural language, and publish the answers as reports, charts, dashboards and scheduled deliveries | [businessappwithai/enterprise_reporting_tanstack](https://github.com/businessappwithai/enterprise_reporting_tanstack) |

**Neither product is vendored here.** This repository is the orchestrator: it
holds the language, the glue and nothing else. Both are checked out on demand at
the commits `../deps.json` pins:

```bash
../deps.sh --install     # place both beside common/, at their pinned commits
../deps.sh --status      # what is checked out, and whether it matches
```

Both read the same language, and everything that is neither product lives in
`common/`, one level up from this file:

```
../
├── deps.json                the two product repositories, and the commit of each
├── deps.sh                  place them locally
├── start.sh                 generate an application and bring both up
├── stop.sh
├── docker-compose.yml
├── app-with-ai-tanstack/            ← placed by ./deps.sh, gitignored
├── enterprise_reporting_tanstack/   ← placed by ./deps.sh, gitignored
└── common/
    ├── language/    ⭐ EML — definition, spec, grammar, checker, fixer, composer, the `eml` CLI
    ├── build/          model → reporting pack · the /app and /report subpath overlay
    ├── seed/           loads the generated application into the reporting platform
    ├── docker/         the two Dockerfiles, nginx, and the demo database init
    ├── scripts/        the checks behind `bun run check:all`
    ├── html/           the published guide, checker.js / fixer.js, run-in-a-browser
    ├── website/
    │   ├── llmtext/    llms.txt · llms-reporting.txt
    │   └── viewers/    the model viewers
    └── examples/       sample models
```

`language/appwithai-language.json` is the canonical definition. Each product
repository keeps its own copy for its own CI — `app-with-ai-tanstack/language/`
under the same name, and `enterprise_reporting_tanstack/language/` as an older
fork called `erdwithai-language.json`. **All three have drifted from each other,
and when any of them disagrees with this copy, this copy is the language.**

They were once meant to be byte-identical, and this file said so. They are not:
at the pinned commits the two `appwithai-language.json` files differ from line 11
on, and nothing checks them against each other. Only the two copies of the shared
*example models* are held byte-identical, by `check:models` — see **Checks**
below.

## Running both, from one model

```bash
./deps.sh --install                           # once — both products, at their pins
./start.sh                                    # the reference CRM model
./start.sh common/examples/my-app.eml.mmd     # any other model
./start.sh my-app.eml.mmd --profile prod      # two database servers
```

`start.sh` refuses to run without the checkouts, and says which one is missing:
without them the generate fails on a module it cannot resolve and compose fails
on a build context that does not exist, both a long way in and neither error
naming what is actually absent.

Then:

| | |
|---|---|
| http://localhost/app | the application generated from the model |
| http://localhost/report | the reporting platform, already holding that application's schema as a data source and its reports, charts and dashboard |

`start.sh` checks the model, generates the application, puts both applications on
their URL prefix, derives the reporting pack from the model, and brings the stack
up. `stop.sh` takes it down; `stop.sh --volumes` discards the databases too.
Everything it writes goes under `common/.runtime/`, which is not checked in.

**The two profiles.** `demo` (the default) runs one pgvector PostgreSQL 16
holding three databases — the application's, `enterprise_config`, and
`ers_knowledge`. `prod` runs two servers, each the image its application actually
asks for: pgvector on PostgreSQL 18 for the generated application, Apache AGE on
16 for the reporting platform. pgvector rather than Apache AGE in the demo is a
forced choice, not a preference: no published image carries both extensions, and
pgvector is the one that is not optional — AGE serves only the reporting
platform's knowledge-graph feature, which is lazy. Under both profiles, the
reporting platform's configuration
never shares a database with the application it reports on — regenerating the
application drops and recreates its tables, and the reports have to survive that.

**Where the reports come from.** `common/build/reporting-pack.ts` derives a
baseline from structure: a register per entity, a breakdown per `%%enum`-bound
column, a lifecycle per state machine in the diagram's own order, children per
`oneToMany`. That baseline describes the shape of the data and nothing about the
business running on it — so a model can also carry `%%report` directives, each a
question its users actually ask written as the SQL that answers it. Those are
listed first and take the top of the dashboard. See
`website/llmtext/llms.txt` §10.5.1.

## One model, three targets

```bash
bun language/checker.ts examples/analytics-reporting.eml.mmd

# A dependency-free prototype
bun language/cli/eml.ts generate -i <model> -o ./out --stack node-rest

# The whole application: NestJS + Fastify + Kysely, TanStack Start front end
bun language/cli/eml.ts generate -i <model> -o ./out --stack tanstack-nestjs

# Entities for the reporting platform: server functions, routes, a Kysely migration
bun language/cli/eml.ts generate -i <model> -o ./out --stack enterprise-reporting
```

The three differ in what they write, never in what they understand — all of them
read the same parsed model. They do not reach equally far into the language, and
the `enterprise-reporting` target reaches least on purpose: that repository
already holds auth, two layers of RBAC, an encrypted connection manager, an
NL→SQL pipeline, a job runner and a UI shell, so the target emits only what a new
entity needs. It does **not** compile workflows or `%%rbac` — see
`language/README.md` for the coverage table, and the `README.md` the target
writes beside its output for the integration steps.

## The two shipped CLIs

`eml.ts` above is this repository's CLI. APPWITHAI publishes two binaries of its
own, and they are not the same entry point — different argument parsing,
different defaults, and in the WASM case a whole stage afterwards:

```bash
# The full stack: NestJS on a PostgreSQL server, TanStack Start in front of it
bun app-with-ai-tanstack/packages/generator/src/cli/generate.ts \
    generate -i <model> -o ./out --force

# The same pipeline, then an overlay: WebAssembly PostgreSQL in place of `pg`,
# node in place of bun. No database server at all.
bun app-with-ai-tanstack/packages/generator/src/cli-wasm/generate.ts \
    generate -i <model> -o ./out --force
```

`bun run check:clis` runs both and checks what each produced rather than only
that it exited 0 — the WASM run has to have written `backend/pg-wasm/`, which is
the overlay's own footprint and the difference between the overlay running and
silently doing nothing.

**Both run on bun 1.4.4**, what app-with-ai-tanstack requires throughout.
`appwithai-wasm` used to be checked on 1.3; upstream dropped 1.3, so that pin
went with it. CI still runs each in a job of its own so they go side by side.
`check:cli` and `check:cli:wasm` run one each; the check always prints the bun a
result came from.

Add `--no-setup` to the full-stack CLI to stop after writing files. Without it
the CLI goes on to install, migrate and seed against a PostgreSQL server on
127.0.0.1, which is the right default for someone generating an application to
run and not what a check wants.

## One docker, or two

Both applications run under one `docker-compose.yml`, and the profile decides
how far apart they sit:

| | |
|---|---|
| `demo` (default) | One PostgreSQL 16 holding three databases — the generated application's, the platform's `enterprise_config`, and its `ers_knowledge`. One container, one image to pull |
| `prod` | A server per application, each the image it actually asks for: pgvector on PostgreSQL 18 for the generated application, Apache AGE on 16 for the reporting platform |

The application containers are separate under both — the generated backend, its
front end, and the reporting platform are three services either way, behind one
nginx on port 80. What the profile changes is the databases. And under both, the
reporting platform's configuration never shares a database with the application
it reports on: regenerating the application drops and recreates its tables, and
the reports have to survive that.

## Reading further

| | |
|---|---|
| The language | [`language/README.md`](language/README.md), then `language/spec/` |
| APPWITHAI, in full | [`website/llmtext/llms.txt`](website/llmtext/llms.txt) |
| The reporting platform, in full | [`website/llmtext/llms-reporting.txt`](website/llmtext/llms-reporting.txt) |
| The human guide | [`html/index.html`](html/index.html) — nine chapters building a CRM |

Each product repository keeps its own `CLAUDE.md`, and that is the authority on
that project's commands, conventions and CI — read it in the checkout `./deps.sh`
placed, not from memory. `../CLAUDE.md` is the authority on this repository and
on how the two are run together.

## Where this repository knowingly differs from the product

`deps.sh` places a checkout; it does not make the copies agree. Three
divergences are deliberate and are recorded here so nobody "fixes" them back.
`/sync-downstream` is the procedure for carrying a generator commit across; this
is the list of things that procedure must *not* flatten.

**The product's language JSON contradicts itself about `icon`, and this copy
does not.** `applicationDictionary.alsoDerived` in
`app-with-ai-tanstack/language/appwithai-language.json` still reads *"validated
but not yet compiled … an entity's icon is not taken from the model"*, while its
own `%%entity` entry three keys away says `icon:` compiles to `sys_table.icon`.
`fe4ff9d` wrote the first; `ffed835` reversed it and left that line standing.
This copy carries the fact rather than the contradiction: `icon` is compiled,
the model sets the default and Application Dictionary → Table and Column keeps
the last word. When the two disagree about the language, **this copy is the
language** — and that is the case it was written for.

**A product change to `llms.txt` fails the site's own spec check.**
`7e6ced3` rewrote the bare-host counter-example as
`[www.appwithai.org](https://www.appwithai.org)`. The site's `check-spec.mjs`
held the apex spelling verbatim, because the bullet exists to *show* a link
around a bare host and so has to be excluded from the scan that forbids one —
so re-vendoring that document made it fail a check about a rule it obeys, on
the very line that teaches the rule. Both spellings are the same lesson and
both are true, so the check now accepts either rather than either document
being edited to suit it. The vendored copy keeps the product's wording; this
repository's own bases keep theirs.

**The hospital model is one document everywhere.**
`app-with-ai-tanstack/examples/hospital-management-system.mmd`, the two twins
in `common/examples/` and the site's `guide/models/` copy are the same 3465-line
file: 88 entities, 51 state machines, one saga, 30 roles and 139 access
restrictions, checking at 0 errors and 0 warnings and scoring 23/23 under the
audit. It replaced both the product's 1057-line example and the site's
1771-line rebuild, so the two no longer differ.

Every `icon:` in every model here and on the site does resolve: 189 names
checked against lucide 1.47.0's 2112 ids, through the same `normalizeIconName`
the generated front end uses (`icon.tsx` — it hyphenates before a digit, so
`Building2` is `building-2` and valid), 0 invalid. A wrong name is not a
diagnostic — the checker does not carry lucide's catalogue — so this is the
only thing that would catch one.

## Checks

This folder has its own manifest and its own checks, separate from either
product's:

```bash
bun install
bun run check:all        # models, types, every stack, both CLIs, and the reporting SQL
```

| | |
|---|---|
| `check:models` | Every model in `language/examples/` and `examples/` checks clean, and `html/models/` is still byte-identical to its counterpart |
| `type-check` | `language/**`, `build/**` and `scripts/**` under the strict config (`tsconfig.language.json`), with `bun check`. There is no linter or formatter |
| `check:stacks` | All three `--stack` targets actually generate |
| `check:clis` | Both shipped binaries generate, and wrote what each stage should. `check:cli` / `check:cli:wasm` run one each — CI uses those, one job each |
| `check:pack` | Every query in every model's reporting pack runs against a **real** generated schema. Skips itself with a message when no PostgreSQL is reachable |

**Every one of these needs `../deps.sh` to have run.** Two modules under
`language/cli` import from `app-with-ai-tanstack` — the shipped JDM converter
and the flowchart parser — and `jdm.ts` does it unconditionally, on every
generation path. Without that checkout `type-check` reports TS2307 and *all
three* stack targets fail at module resolution, not just the heavy one.

`check:stacks` and `check:clis` additionally need that workspace's own
dependencies installed (`../deps.sh --install`): `tanstack-nestjs` and both
shipped binaries drive the orchestrator, which resolves `zod` and the rest from
there. Pass `--skip-heavy` to run only the two self-contained targets:

```bash
bun scripts/check-stacks.ts --skip-heavy
```

## CI

`.github/workflows/` holds two workflows:

| | |
|---|---|
| `root-ci.yml` | `paths:`-filtered to `common/**`, `deps.json` and the scripts that run the two together. A `resolve` job reads `deps.json`, then four jobs check out `app-with-ai-tanstack` against it and run models/types, every `--stack` target plus the `appwithai` CLI, the `appwithai-wasm` CLI, and the reporting pack against a real PostgreSQL |
| `build-and-run.yml` | The orchestrator, on `workflow_dispatch` and nightly. Checks out both products at their pins, generates an application, injects configuration, brings the stack up, and proves `/app` and `/report` answer — content types included, via `common/build/smoke.sh` — and that the seeder exited 0 |

Both workflows read the pins from `deps.json` and nowhere else — no workflow
restates a ref in a `with:` block, which is how pins drift. Each product's own CI
lives in its own repository, where the code is. That also means `paths:` cannot
watch them: a change to `app-with-ai-tanstack` does not trigger a run here, and
the nightly `build-and-run` is what notices instead.
