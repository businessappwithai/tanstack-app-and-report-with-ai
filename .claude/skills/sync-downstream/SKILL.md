---
name: sync-downstream
description: Carry a new commit of businessappwithai/app-with-ai-tanstack into the two repositories that read it — this orchestrator and businessappwithai.github.io. Use when the generator has been updated and the pin, the canonical language definition, the four protocol documents, the vendored bundles or the published models need to catch up. Triggers: "update the other repos", "sync the downstream repos", "app-with-ai-tanstack has changed", "move the pin".
---

# Syncing the two downstream repositories

`app-with-ai-tanstack` is upstream of both this repository and
`businessappwithai.github.io`. Nothing propagates on its own: every copy is
either pinned, vendored or hand-carried, and the version string is `1.2.0` in
all three language definitions whatever they actually contain. This is the
order that works.

Paths below are written from a checkout root that holds all four repositories
side by side. `$A` is `app-with-ai-tanstack`, `$O` this repository, `$W` the
website.

---

## 0. Find out what actually changed

Do this first. Most upstream commits change nothing either repository carries,
and the work is then only the pin.

```bash
OLD=$(python3 -c "import json;print([d for d in json.load(open('$O/deps.json'))['dependencies'] if d['name']=='app-with-ai-tanstack'][0]['ref'])")
cd $A && git log --oneline $OLD..HEAD | cat
git diff --stat $OLD..HEAD -- language/ website/ html/ examples/ docs/eml-sessions/
```

Only those five directories can reach a downstream repository. A change
anywhere else under `packages/` matters only through the **built bundles**,
which are committed upstream and listed in §3.

**Then check what is already carried rather than assuming.** Earlier sessions
carry work forward, so grep for a marker of each upstream change in each copy
before editing anything:

```bash
for m in <marker> <marker>; do
  for c in llms.txt working-session.txt eml-syntax.txt eml-dictionary.txt eml-reporting.txt checker-rules.txt enhancement-examples.txt; do
    for f in $A/website/llmtext/$c \
             $O/common/website/llmtext/$c \
             $W/$c; do
      grep -qF -- "$m" "$f" && printf "%-70s yes\n" "$f"
    done
  done
done
```

---

## 1. Move the pin — `$O/deps.json`

`ref` is the only place any ref lives; every workflow reads it in a `resolve`
job. Replace the `app-with-ai-tanstack` `ref` with the commit you are moving
to, leave `branch` alone, then prove it resolves:

```bash
cd $O && ./deps.sh --install && ./deps.sh --status
```

`--install` installs `app-with-ai-tanstack` only; the line reading
`no install needed (see deps.json)` for the reporting platform is correct.

If the commit is ahead of upstream's `main` (a branch that has not merged yet),
say so in the commit message — a later `./deps.sh --update` resolves `branch`
and would move the pin backwards.

---

## 2. The canonical language definition — `$O/common/language/appwithai-language.json`

**This copy is canonical when the three disagree.** Compare normalized, or the
diff is hundreds of lines of `—`-versus-`—` and compact-versus-expanded
arrays:

```bash
python3 -c "
import json
for s,d in [('$A/language/appwithai-language.json','/tmp/up.json'),
            ('$O/common/language/appwithai-language.json','/tmp/orc.json')]:
    json.dump(json.load(open(s)),open(d,'w'),indent=2,ensure_ascii=False,sort_keys=True)
"
diff /tmp/up.json /tmp/orc.json
```

**Edit it as text, never by re-serialising.** `json.dumps` expands every
compact array and re-escapes every em dash, which buries a ten-line change in
three hundred lines of churn. Replace exact string literals with
`assert s.count(old) == 1` around each one.

Keep this repository's own deltas: `generatorContract.targets`,
`repositoryLayout`, its `common/`-relative paths, its `language.description`,
and any diagnostic-range note that is richer here than upstream.

---

## 3. The built bundles — copy, never rebuild

These are committed upstream. Their bytes depend on the bun version **and the
platform**, so rebuilding them anywhere but where upstream's CI builds commits
bytes that CI will reject.

| To | From |
|---|---|
| `$O/common/website/viewers/eml-model.js` | `$A/website/viewers/eml-model.js` |
| `$W/guide/checker.js` | `$A/html/checker.js` |
| `$W/guide/fixer.js` | `$A/html/fixer.js` |
| `$W/assets/js/appwithai-wasm.js` | `$A/html/assets/appwithai-wasm.js` |
| `$W/assets/js/appwithai-fullstack.js` | `$A/html/assets/appwithai-fullstack.js` |
| `$W/viewers/eml-model.js` | `$A/website/viewers/eml-model.js` |
| `$W/guide/wasm-app/sw.js` | `$A/html/wasm-app/sw.js` |

**The orchestrator's two validators are no longer on that list — they are built.**
`$O/common/html/checker.js` and `fixer.js` are bundled from its own
`language/browser/*.entry.ts`, which inline its own canonical
`appwithai-language.json`. Copying the product's over them re-introduces a
validator that disagrees with the language beside it. After changing that
repository's language definition or checker, rebuild instead:

```bash
cd $O/common && bun run build:language-tools && bun run check:language-tools
```

**Build them on CI's runtime.** `Bun.build` output depends on the bun version and
the platform; `root-ci.yml` pins `BUN_VERSION: 1.4.4` on `linux-x64`. Building on
anything else commits bytes CI rejects while `--check` passes locally — which is
exactly how the branch this came from shipped a build from an older bun. `--check` prints
which case a mismatch is; read it rather than rebuilding reflexively.

`$W/guide/checker.js` on the **site** stays vendored from the product, because the
site publishes the product's validators. The two are now deliberately different
bundles, and that is not drift.

**`$W/assets/vendor/stack-templates.json` is the trap.** It is gitignored
upstream, so it is not in the checkout and a `cp` silently skips it — while
`appwithai-fullstack.js` beside it now wants templates the old payload does
not carry. Build it:

```bash
cd $O/app-with-ai-tanstack && bun run build:stack-templates
cp html/assets/stack-templates.json $W/assets/vendor/stack-templates.json
```

The symptom of forgetting is `website-e2e.mjs` dying with `ENOENT` on a
`.hbs` path, or a `carries(...)` assertion reporting the payload "predates the
feature".

**Files with local deltas — check before copying.** `$W/assets/js/run-in-browser.js`
and `run-real-stack.js` carry site-only changes (the `awTrack` lines, the
vendored PGlite shim, `overlay: false`, the extra `BUILT_IN` entries,
`?theme=dark`, the `guide/` import paths). `$W/viewers/index.html` is authored
here, not vendored. If upstream changed either `run-*.js`, re-apply every delta
the website's CLAUDE.md tabulates; if it did not, leave them alone.

---

## 4. The protocol documents

One protocol, published as a short controller `llms.txt` plus six lazy-loaded chunks
(`working-session`, `eml-syntax`, `eml-dictionary`, `eml-reporting`, `checker-rules`, `enhancement-examples`, each `.txt`).
All seven are upstream's `$A/website/llmtext/*.txt`, copied byte for byte — nothing is
authored or derived downstream. The four older `.txt` documents are deleted everywhere. There is no `llms.md`: GitHub Pages types `.md` as
`text/markdown`, which ChatGPT's web reader refuses.

| To | From |
|---|---|
| `$O/common/website/llmtext/<each of the seven>` | `$A/website/llmtext/<same name>` |
| `$W/<each of the seven>` | `$A/website/llmtext/<same name>` |

Verify the copies:

```bash
for d in $O/common/website/llmtext $W; do
  for c in llms.txt working-session.txt eml-syntax.txt eml-dictionary.txt eml-reporting.txt checker-rules.txt enhancement-examples.txt; do
    cmp $d/$c $A/website/llmtext/$c && echo "ok $d/$c"
  done
done
```

Then run each repository's own check: `bun run test:llmtext` in `$A`,
`node scripts/check-spec.mjs` in `$W`. `llms-reporting.txt` in the orchestrator
is its own document and is not part of this.

---

## 5. The models

- `$O/common/examples/hospital-management-system.mmd` twins
  `$A/examples/hospital-management-system.mmd`. `diff` them; they are meant to
  match.
- `$O/common/{language/examples,html/models}/` must stay byte-identical to each
  other — `check:models` asserts it. **Edit both.**
- `$W/guide/models/crm.eml.mmd` and `drug-discovery.eml.mmd` must stay
  byte-identical to `$A/html/models/`; `dance-studio` twins
  `$A/language/examples/`.
- The site's `hospital-management-system.eml.mmd` is byte-identical to
  `$A/examples/hospital-management-system.mmd` again (88 entities); the
  older, divergent rebuild is gone. `check-upstream.mjs` holds the pair.

---

## 6. Rebuild what the website derives from the validators

Any change to `$W/guide/checker.js` or `fixer.js` stales three more artifacts:

```bash
cd $W
node scripts/build-validator-source-page.mjs     # guide/source/
node scripts/build-standalone-checker.mjs        # guide/check-model-standalone.mjs
```

---

## 7. Run the checks

Orchestrator — everything but the pack, which needs a PostgreSQL:

```bash
cd $O/common && bun install
bun run check:models && bun run type-check \
  && bun run check:stacks && bun run check:clis && bun run check:pack
cd $O && git status --porcelain     # CI fails on a dirty tree
```

`type-check` reporting TS2307 on `jdm.ts` and `reporting-pack.ts` means the
dependency checkouts are not placed — that is step 1, not a broken repository.

Website — this is `tests.yml`, in order, Node only:

```bash
cd $W
node scripts/check-spec.mjs
node scripts/build-validator-source-page.mjs --check
node scripts/check-validator-source-pages.mjs
node scripts/build-standalone-checker.mjs --check
for m in guide/models/*.mmd; do node guide/check-model.mjs "$m" --quiet; done
for m in guide/models/*.mmd; do node guide/audit-model.mjs "$m" --quiet; done   # each must be 22/22
node scripts/website-e2e.mjs
```

---

## 8. Commit and push

Both repositories develop on the branch this session was given. Say in each
commit message what moved upstream and what was carried — and, where a check
was changed rather than a document, why the check was the thing that was wrong.
