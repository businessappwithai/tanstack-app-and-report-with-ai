#!/usr/bin/env bun
/**
 * Place the two product repositories this one orchestrates, at the commits
 * `deps.json` pins.
 *
 * Neither is vendored here, and neither is a submodule. They are separate
 * repositories with their own CI, their own release cadence and their own
 * lockfiles; this repository holds the language they both read and the pieces
 * that run them together, and names the commit of each it is known to work
 * with. CI does the same thing with `actions/checkout` — same `deps.json`, same
 * refs — so a local tree and a runner check out identically.
 *
 *   ./deps.sh                 clone or update both to their pinned refs
 *   ./deps.sh --update        resolve each branch to its head and rewrite deps.json
 *   ./deps.sh --status        say what is checked out, and whether it matches
 *   ./deps.sh --install       also `bun install --frozen-lockfile` in each
 *
 * The checkouts land beside this repository's own folders and are gitignored.
 * They are working trees, not build output: `--update` rewrites the pins but
 * never touches a checkout that has local changes, because the most likely
 * reason a dependency has uncommitted work in it is that someone is debugging
 * across the boundary.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const DEPS_FILE = path.join(ROOT, "deps.json");

interface Dependency {
  name: string;
  repository: string;
  path: string;
  branch: string;
  ref: string;
  /**
   * Whether `--install` installs this checkout's own dependencies.
   *
   * Only true where something on this machine resolves modules out of it —
   * app-with-ai-tanstack, because the tanstack-nestjs target drives its
   * orchestrator in-process. A checkout that is only ever a Docker build
   * context does not need one: the image build installs inside the image.
   */
  install?: boolean;
  needed_for?: string[];
}

interface DepsFile {
  dependencies: Dependency[];
  [key: string]: unknown;
}

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function die(message: string): never {
  console.error(`${red("error:")} ${message}`);
  process.exit(1);
}

function git(args: string[], cwd: string = ROOT): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function run(cmd: string, args: string[], cwd: string): boolean {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  return r.status === 0;
}

function readDeps(): DepsFile {
  if (!existsSync(DEPS_FILE)) die(`deps.json not found at ${DEPS_FILE}`);
  const parsed = JSON.parse(readFileSync(DEPS_FILE, "utf8")) as DepsFile;
  if (!Array.isArray(parsed.dependencies) || parsed.dependencies.length === 0) {
    die("deps.json has no `dependencies` array.");
  }
  return parsed;
}

const url = (dep: Dependency) => `https://github.com/${dep.repository}`;

/** The commit a checkout is actually on, or null when there is no checkout. */
function headOf(dir: string): string | null {
  if (!existsSync(path.join(dir, ".git"))) return null;
  const r = git(["rev-parse", "HEAD"], dir);
  return r.ok ? r.out : null;
}

function isDirty(dir: string): boolean {
  const r = git(["status", "--porcelain"], dir);
  return r.ok && r.out.length > 0;
}

/**
 * Clone if absent, fetch if present, then check out the pinned commit.
 *
 * The clone is deliberately not `--depth 1`: the pin is a commit that may be
 * behind the branch head, and a depth-1 clone of a branch cannot check out a
 * commit that is not its tip. Fetching the single pinned commit is tried first
 * anyway — most servers allow it, and it is far cheaper than full history.
 */
function place(dep: Dependency): boolean {
  const dir = path.join(ROOT, dep.path);
  const label = bold(dep.name);

  if (!existsSync(path.join(dir, ".git"))) {
    console.log(`\n${label}  cloning ${dep.repository}`);
    if (existsSync(dir)) {
      die(
        `${dep.path} exists but is not a git checkout. Move it aside — this script will not delete it.`
      );
    }
    if (!run("git", ["clone", "--filter=blob:none", url(dep), dir], ROOT)) {
      console.error(`  ${red("clone failed")}`);
      return false;
    }
  } else {
    const remote = git(["remote", "get-url", "origin"], dir);
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/\.git$/, "")
        .replace(/\/$/, "");
    if (remote.ok && normalize(remote.out) !== normalize(url(dep))) {
      console.error(
        `\n${label}  ${red("wrong repository")}: ${dep.path} has origin ${remote.out}, expected ${url(dep)}`
      );
      return false;
    }
  }

  const head = headOf(dir);
  if (head === dep.ref) {
    console.log(`\n${label}  already at ${dep.ref.slice(0, 8)}`);
    return true;
  }

  if (isDirty(dir)) {
    console.error(
      `\n${label}  ${red("has uncommitted changes")} — refusing to move it off ${head?.slice(0, 8) ?? "its checkout"}.`
    );
    console.error(`  Commit, stash or discard them in ${dep.path}, then run this again.`);
    return false;
  }

  console.log(`\n${label}  fetching ${dep.ref.slice(0, 8)}`);
  // Ask for the one commit; fall back to the branch when the server refuses.
  if (!run("git", ["fetch", "--filter=blob:none", "origin", dep.ref], dir)) {
    if (!run("git", ["fetch", "--filter=blob:none", "origin", dep.branch], dir)) {
      console.error(`  ${red("fetch failed")}`);
      return false;
    }
  }
  if (!run("git", ["checkout", "--detach", dep.ref], dir)) {
    console.error(`  ${red("checkout failed")} — is ${dep.ref} a commit on ${dep.repository}?`);
    return false;
  }
  return true;
}

function install(dep: Dependency): boolean {
  const dir = path.join(ROOT, dep.path);
  if (dep.install !== true) {
    console.log(`\n${bold(dep.name)}  ${dim("no install needed (see deps.json)")}`);
    return true;
  }
  if (!existsSync(path.join(dir, "package.json"))) return true;
  console.log(`\n${bold(dep.name)}  bun install --frozen-lockfile`);
  return run("bun", ["install", "--frozen-lockfile"], dir);
}

function status(deps: Dependency[]): number {
  let wrong = 0;
  for (const dep of deps) {
    const dir = path.join(ROOT, dep.path);
    const head = headOf(dir);
    if (head === null) {
      console.log(`  ${red("missing")}  ${dep.name}  ${dim(`run ./deps.sh to place it`)}`);
      wrong++;
    } else if (head === dep.ref) {
      const dirty = isDirty(dir) ? dim("  (uncommitted changes)") : "";
      console.log(`  ok       ${dep.name}  ${head.slice(0, 8)}${dirty}`);
    } else {
      console.log(
        `  ${red("drifted")}  ${dep.name}  at ${head.slice(0, 8)}, pinned to ${dep.ref.slice(0, 8)}`
      );
      wrong++;
    }
  }
  return wrong;
}

/** Resolve each branch to its current head and rewrite the pins in place. */
function update(file: DepsFile): number {
  let moved = 0;
  let failed = 0;
  for (const dep of file.dependencies) {
    const r = git(["ls-remote", url(dep), `refs/heads/${dep.branch}`]);
    const sha = r.ok ? (r.out.split(/\s+/)[0] ?? "") : "";
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      console.error(`  ${red("failed")}   ${dep.name}  could not resolve ${dep.branch}`);
      failed++;
      continue;
    }
    if (sha === dep.ref) {
      console.log(`  ok       ${dep.name}  already at ${dep.branch} head ${sha.slice(0, 8)}`);
      continue;
    }
    console.log(`  moved    ${dep.name}  ${dep.ref.slice(0, 8)} → ${sha.slice(0, 8)}`);
    dep.ref = sha;
    moved++;
  }
  if (moved > 0) {
    writeFileSync(DEPS_FILE, `${JSON.stringify(file, null, 2)}\n`);
    console.log(`\n  deps.json rewritten. ${bold("Run the checks before committing it:")}`);
    console.log("    ./deps.sh && cd common && bun run check:all");
  }
  return failed;
}

// --- main --------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
for (const a of args) {
  if (!["--update", "--status", "--install", "-h", "--help"].includes(a)) {
    die(`Unknown option: ${a}`);
  }
}

if (args.has("-h") || args.has("--help")) {
  console.log(
    [
      "Place the product repositories this one orchestrates, at the commits deps.json pins.",
      "",
      "  ./deps.sh              clone or update both to their pinned refs",
      "  ./deps.sh --install    also bun install --frozen-lockfile in each",
      "  ./deps.sh --status     say what is checked out, and whether it matches",
      "  ./deps.sh --update     resolve each branch to its head and rewrite deps.json",
    ].join("\n")
  );
  process.exit(0);
}

const file = readDeps();

if (args.has("--status")) {
  console.log(`\n${bold("Dependencies")}`);
  process.exit(status(file.dependencies) === 0 ? 0 : 1);
}

if (args.has("--update")) {
  console.log(`\n${bold("Resolving each branch to its head")}`);
  process.exit(update(file) === 0 ? 0 : 1);
}

let failed = 0;
for (const dep of file.dependencies) {
  if (!place(dep)) {
    failed++;
    continue;
  }
  if (args.has("--install") && !install(dep)) {
    console.error(`  ${red("install failed")}`);
    failed++;
  }
}

console.log(`\n${bold("Dependencies")}`);
status(file.dependencies);

if (failed > 0) {
  console.error(`\n${failed} dependency(ies) could not be placed.`);
  process.exit(1);
}
console.log("\nBoth checkouts are at their pinned commits.");
