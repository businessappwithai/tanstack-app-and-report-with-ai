#!/usr/bin/env bun
/**
 * Generate the same model through both of APPWITHAI's command-line interfaces
 * and assert each produced the application it claims to.
 *
 * There are two, and `check-stacks.ts` exercises neither of them. That script
 * drives `language/cli/eml.ts` — this repository's own CLI, which for the
 * `tanstack-nestjs` target loads the generator's orchestrator as a library.
 * The two shipped binaries are a different entry point with their own argument
 * parsing, their own defaults and, in the WASM case, a whole overlay stage
 * after generation:
 *
 *   appwithai       packages/generator/src/cli/generate.ts
 *                   the full stack — NestJS on a PostgreSQL server, TanStack
 *                   Start in front of it, Bun as the runtime.
 *
 *   appwithai-wasm  packages/generator/src/cli-wasm/generate.ts
 *                   the same stack, then an overlay that replaces `pg` with
 *                   WebAssembly PostgreSQL and Bun with Node, so it runs with
 *                   no database server at all.
 *
 * The overlay is why the second is checked rather than assumed: it is the
 * stage where a rename in the generator turns into an application that
 * generates cleanly and then cannot start, and running the first CLI proves
 * nothing about it.
 *
 * `--no-setup` on the full-stack CLI, deliberately. Without it the CLI installs
 * dependencies, migrates and seeds against a PostgreSQL server on 127.0.0.1 —
 * a fine default for someone generating an application to run, and not what
 * this check is asking. What is being checked is that the CLI produces the
 * application; whether a database happens to be listening is a separate
 * question that `check-reporting-pack.ts` answers with a real one.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const APP_REPO = path.resolve(ROOT, "..", "app-with-ai-tanstack");
const MODEL = process.env.CHECK_CLIS_MODEL ?? "language/examples/crm.eml.mmd";

/** `--only <name>` runs one CLI. CI uses it to give each its own bun. */
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined;

interface Cli {
  /** The name the binary is published under. */
  readonly name: string;
  /** Entry point, relative to the app repository. */
  readonly entry: string;
  /** Arguments after `generate -i <model> -o <out>`. */
  readonly args: readonly string[];
  /** The fewest files a run may legitimately write. */
  readonly minFiles: number;
  /**
   * The bun this CLI is meant to run on. Both are 1.4 now: app-with-ai-tanstack
   * requires 1.4.4 throughout, the generator that ships both CLIs included,
   * and the Dockerfiles `appwithai` generates run on it. The WASM path was
   * kept on 1.3 until upstream dropped it.
   *
   * Reported rather than enforced — a script cannot re-exec itself under
   * another runtime, and refusing to run would make a local sanity check
   * useless on whichever bun someone happens to have. CI pins the runtime;
   * the line printed below always names the bun the result came from, so a
   * green run on the wrong runtime cannot read as the right one.
   */
  readonly bun: string;
  /**
   * Paths that must exist under the output. Each one is the evidence that a
   * particular stage ran, not decoration — see the comment beside it.
   */
  readonly expect: readonly { path: string; why: string }[];
}

const CLIS: readonly Cli[] = [
  {
    name: "appwithai",
    entry: "packages/generator/src/cli/generate.ts",
    args: ["--force", "--no-setup"],
    minFiles: 200,
    bun: "1.4",
    expect: [
      { path: "backend/src/main.ts", why: "the NestJS backend" },
      { path: "frontend/src/router.tsx", why: "the TanStack Start frontend" },
      { path: "docker-compose.yml", why: "the way the generated app is run" },
      { path: "model/model.eml.mmd", why: "the model the app answers questions from" },
    ],
  },
  {
    name: "appwithai-wasm",
    entry: "packages/generator/src/cli-wasm/generate.ts",
    args: ["--force"],
    minFiles: 200,
    bun: "1.4",
    expect: [
      { path: "backend/src/main.ts", why: "the same backend the other CLI writes" },
      // The overlay's own footprint. Without these the run generated the
      // ordinary stack and the WASM stage silently did nothing.
      { path: "backend/pg-wasm/index.d.ts", why: "the WebAssembly PostgreSQL shim" },
      { path: "backend/pg-wasm/package.json", why: "the shim resolving as `pg`" },
    ],
  },
];

function countFiles(dir: string): number {
  let n = 0;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const p = path.join(dir, entry);
    n += statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}

if (!existsSync(path.join(ROOT, MODEL))) {
  console.error(`Model not found: ${MODEL}`);
  process.exit(1);
}
if (!existsSync(APP_REPO)) {
  console.error(
    `app-with-ai-tanstack is not present at ${APP_REPO}.\n` +
      "Both CLIs ship from that repository — run ./deps.sh --install first, which\n" +
      "places it at the commit deps.json pins and installs its dependencies."
  );
  process.exit(1);
}

let failed = 0;

const selected = only ? CLIS.filter((c) => c.name === only) : CLIS;
if (selected.length === 0) {
  console.error(`No such CLI: ${only}. Known: ${CLIS.map((c) => c.name).join(", ")}`);
  process.exit(2);
}

const runningBun = Bun.version.split(".").slice(0, 2).join(".");

for (const cli of selected) {
  const entry = path.join(APP_REPO, cli.entry);
  if (!existsSync(entry)) {
    failed++;
    console.error(`  FAIL  ${cli.name} entry point missing: ${cli.entry}`);
    continue;
  }

  const out = mkdtempSync(path.join(tmpdir(), `cli-${cli.name}-`));
  const run = spawnSync(
    "bun",
    [entry, "generate", "-i", path.join(ROOT, MODEL), "-o", out, ...cli.args],
    { cwd: APP_REPO, encoding: "utf8" }
  );

  if (run.status !== 0) {
    failed++;
    console.error(`  FAIL  ${cli.name} exited ${run.status}`);
    console.error(`${run.stdout ?? ""}${run.stderr ?? ""}`.replace(/^/gm, "        "));
    rmSync(out, { recursive: true, force: true });
    continue;
  }

  const written = countFiles(out);
  const missing = cli.expect.filter((e) => !existsSync(path.join(out, e.path)));
  rmSync(out, { recursive: true, force: true });

  if (written < cli.minFiles) {
    failed++;
    console.error(
      `  FAIL  ${cli.name} wrote ${written} file(s), expected at least ${cli.minFiles}`
    );
    continue;
  }
  if (missing.length > 0) {
    failed++;
    console.error(`  FAIL  ${cli.name} wrote ${written} file(s) but not:`);
    for (const m of missing) console.error(`          ${m.path}  — ${m.why}`);
    continue;
  }
  const note =
    runningBun === cli.bun
      ? `bun ${Bun.version}`
      : `bun ${Bun.version} — this CLI is pinned to ${cli.bun}.x`;
  console.log(`  ok    ${cli.name.padEnd(15)} ${String(written).padStart(3)} file(s)  ${note}`);
}

if (failed) {
  console.error(`\n${failed} CLI(s) failed.`);
  process.exit(1);
}
console.log(`\n${selected.length === CLIS.length ? "Both CLIs" : selected[0]?.name} generated.`);
