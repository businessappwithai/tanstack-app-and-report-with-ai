# EML Overview

**APPWITHAI Modeling Language (EML)**, version 1.2.0 — a Mermaid-based language
for describing an application's data model, business rules, and business
workflows as one artifact.

## Design goals

1. **One language, three concerns.** Structure (ERD), decision logic (rules),
   and process (workflows) are expressed with a shared, coherent syntax.
2. **Valid Mermaid.** Every EML document renders as-is in any Mermaid viewer.
   Nothing is lost when a stakeholder opens the file in a diagram tool.
3. **Machine-readable and standalone.** The entire language is defined in
   `language/appwithai-language.json`, independent of any single parser, so the
   generator (and future tooling) reads one authoritative contract.
4. **Renderer-safe extensibility.** Extra semantics ride on `%%` comments, which
   Mermaid ignores. Adding generator meaning never breaks rendering.

## Document model

An EML document is a UTF-8 text file containing one or more **sections**. Each
section opens with a Mermaid diagram keyword:

| Opening keyword | Section |
|-----------------|---------|
| `erDiagram` | ERD |
| `flowchart` / `graph` | Business rules **or** workflow (disambiguated below) |
| `stateDiagram-v2` | Workflow (state-machine form) |

A single file may hold several sections separated by blank lines.

### Comments and directives

- A line starting with `%%` is a Mermaid comment.
- A **plain** comment (`%% notes...`) is documentation, ignored by everyone.
- A **directive** comment begins with a reserved keyword and carries meaning to
  the generator while staying invisible to renderers:

  ```
  %%meta     %%hook     %%step      %%action   %%entity   %%field
  %%enum     %%category %%index     %%rule     %%guard    %%loop
  %%rbac     %%trigger  %%workflow
  ```

  Most of these are **compiled** — a shipped reader consumes them and the
  generated application changes as a result. Three (`%%entity`, `%%rule`,
  `%%trigger`) are **validated**: nothing compiles them yet, but `checker.ts`
  enforces their syntax so a malformed one fails validation rather than being
  silently dropped.

  Each directive carries its own `status` in `appwithai-language.json`, which is
  authoritative. See [`05-directives.md`](05-directives.md) for the reference.

### Disambiguating flowchart vs. rules vs. workflow

A `flowchart` is read as a **business-rules decision flow** when:

- it is preceded by `%%meta kind: rules`, **or**
- it contains only decision/expression/function/io node shapes and **no**
  `%%hook` directives.

Otherwise a `flowchart` is read as a **workflow**. A `stateDiagram-v2` is always
a workflow (its states map to a status enum for the bound entity).

## The pipeline

Every entry point — the `appwithai` CLI and the web app's `/api/generate` —
runs the same pipeline, so a model produces the same application however it was
submitted.

```
ERD section          → mermaid.parser      → Entity[] + Relationship[]  → migrations, DTOs, services, controllers, UI
  %%index            → ┘                     entity.indexes             → real DDL indexes
  %%enum / %%field   → ┘                     bound enums                → typed columns + UI selects
%%category           → category.parser     → dictionary groups          → dashboard grouping
Rules section        → flowchart-parser    → jdm-converter              → GoRules JDM graph → sys_rule_definitions
  %%action           → compileRules        → JDM decision table         → rule actions (incl. trigger-workflow)
Workflow, hook form  → compileHooks        → handler modules + registry → service lifecycle wiring
Workflow, state form → compileWorkflows    → BPMN                       → sys_workflow_definitions, status machine
Workflow, saga form  → compileSagaWorkflows→ one serviceTask per %%step → sys_workflow_definitions (source: model)
%%rbac               → compileRbac         → operation rules (never a transition) → sys_operation_access
Whole document       → rag.ts              → retrieval chunks           → pgvector model_context index
```

Reference implementations — the generator's own readers, which are what decide
what a generated application contains:

- `packages/generator/src/pipeline/generate-application.ts` — the one path
- `packages/generator/src/parsers/mermaid.parser.ts` — ERD, `%%index`, `%%enum`
- `packages/generator/src/parsers/category.parser.ts` — `%%category`
- `packages/generator/src/rules/` — `flowchart-parser.ts`, `jdm-converter.ts`, `index.ts` (`%%action`)
- `packages/generator/src/hooks/index.ts` — `%%hook`, handler form
- `packages/generator/src/workflows/` — `index.ts` (state, saga), `steps.ts` (`%%step`, `%%loop`)
- `packages/generator/src/rbac/index.ts` — `%%rbac` on CRUD operations and on the moves of a record's flow (its action buttons), `reopen` included

The web app keeps its own parsers for the editors — they run in the browser and
cannot import the generator. They read the same syntax but do not decide what is
generated; when the two disagree, the generator's copy is the language and the
web copy is the bug.

## Validation

Two commands, and the second reads what the first wrote.

```bash
bun language/checker.ts model.mmd          # writes model.mmd.error beside it
bun language/fixer.ts   model.mmd.error    # applies the auto-fixable codes, re-checks
```

The checker validates a document against `appwithai-language.json` and emits
diagnostics at three severities:

| Severity | Meaning | Fails the run |
|----------|---------|---------------|
| **error** | The document is wrong; the generator would produce something incorrect or nothing at all. | yes |
| **warning** | Legal, but almost certainly not what the author meant — a dropped modifier, a state with no enum behind it. | only with `--strict` |
| **info** | Worth reading once. | no |

Codes are grouped by what they are about: `EML0xx` document, `EML1xx` entities
and their directives, `EML2xx` directive-declared hooks/rules/workflows,
`EML3xx` rule flowcharts, `EML4xx` workflow sections, `EML5xx` cross-section
consistency. The full list, the auto-fixable set, and what each fix does are in
the `diagnostics` block of `appwithai-language.json`.

Warnings are worth reading rather than clearing: most of them describe something
the generator will silently accept and quietly get wrong. `EML118` is the
clearest case — an unrecognised modifier is dropped, so `string email UNQIUE`
generates a column that is simply not unique, and the rendered diagram looks
exactly the same either way.

## Naming conventions

| Element | Rule | Recommended case |
|---------|------|------------------|
| Entity name | `^[a-zA-Z][a-zA-Z0-9_]*$` | `PascalCase` |
| Attribute name | `^[a-zA-Z][a-zA-Z0-9_]*$` | `snake_case` |
| Hook / handler | `^[a-zA-Z_][a-zA-Z0-9_]*$` | `camelCase` |
| Enum name | `^[A-Za-z][A-Za-z0-9_]*$` | `PascalCase` |
| Node id (flows) | `^[A-Za-z_][A-Za-z0-9_]*$` | short `A`, `B`, … |

Continue with:

- [`01-erd.md`](01-erd.md) — Entity Relationship Diagrams
- [`02-business-rules.md`](02-business-rules.md) — Business rules
- [`03-workflows.md`](03-workflows.md) — Workflows
- [`04-types-and-modifiers.md`](04-types-and-modifiers.md) — Types, modifiers, cardinalities
- [`05-directives.md`](05-directives.md) — Directive reference
