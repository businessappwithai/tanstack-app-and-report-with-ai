/**
 * Why a `--check` step is reporting a mismatch, in terms a reader can act on.
 *
 * Five committed artifacts are compared against a fresh build, byte for byte.
 * They are not all the same kind of thing, and that is the whole point of this
 * module:
 *
 *   bundler output    html/checker.js, html/fixer.js, html/assets/*.js
 *                     Produced by `Bun.build`, whose output depends on the bun
 *                     version *and* the platform — the full-stack bundle is
 *                     807407 bytes built on macOS and 807697 on Linux, same
 *                     bun 1.4.0, same frozen lockfile.
 *
 *   verbatim copies   runtime-assets.generated.ts, overlay-assets.generated.ts,
 *                     html/wasm-app/sw.js
 *                     Files read and re-emitted as JSON string literals. Byte
 *                     identical everywhere.
 *
 * A mismatch therefore means different things depending on which one it is, and
 * "is out of date" alone reads as *you forgot to run the build* — true for the
 * second kind, and only sometimes true for the first. That ambiguity cost one
 * contributor three commits to unpick (ISSUE-018) and led another to write off
 * genuine staleness as a bundler-version artifact. Both would have been a
 * glance if the message had said which.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Where CI's pinned version lives, so this cannot drift from the workflow. */
const WORKFLOW = ".github/workflows/ci.yml";

/** Every CI job runs on `ubuntu-latest`; the workflow holds no variable for it. */
const CI_PLATFORM = "linux-x64";

/** e.g. `bun 1.4.0 on linux-x64` — or node, if somehow run without Bun. */
function runtimeLabel(): string {
  const runtime =
    typeof Bun === "undefined" ? `node ${process.versions.node}` : `bun ${Bun.version}`;
  return `${runtime} on ${process.platform}-${process.arch}`;
}

/**
 * The `BUN_VERSION` the CI workflow pins, or null when it cannot be read.
 *
 * Parsed rather than hardcoded: a message that confidently names the wrong
 * version is worse than one that admits it does not know.
 */
function pinnedBunVersion(root: string): string | null {
  try {
    const workflow = readFileSync(join(root, WORKFLOW), "utf-8");
    return /^\s*BUN_VERSION:\s*["']?([\w.]+)["']?/m.exec(workflow)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * What to print under "is out of date" for a `Bun.build` artifact.
 *
 * Says what produced this build and what produces CI's, then — because those
 * two facts are only useful together — what the difference between them means
 * for the reader's next move. Ends with a newline; append it unconditionally.
 */
export function bundlerEnvNotice(root: string): string {
  const here = runtimeLabel();
  const pinned = pinnedBunVersion(root);
  const expected = pinned ? `bun ${pinned} on ${CI_PLATFORM}` : `whatever ${WORKFLOW} pins`;
  const matchesCi = pinned !== null && here === `bun ${pinned} on ${CI_PLATFORM}`;

  const lines = ["", `  built here with   ${here}`, `  CI builds with    ${expected}`, ""];

  if (matchesCi) {
    lines.push(
      "  Same runtime and platform as CI, so this is genuine staleness.",
      "  Rebuild and commit the result.",
      ""
    );
  } else {
    lines.push(
      "  These differ, and Bun.build's output depends on both. The committed",
      "  copy may not be stale at all — and rebuilding here would replace it",
      "  with a third variant that is byte-wrong for CI while looking correct",
      "  locally. Build where CI builds:",
      "",
      `    docker run --rm -v "$PWD":/w -w /w oven/bun:${pinned ?? "<pinned>"} \\`,
      "      sh -c 'bun install --frozen-lockfile && bun run <this script>'",
      ""
    );
  }

  return lines.join("\n");
}

/**
 * What to print under "is out of date" for a verbatim copy.
 *
 * No bundler is involved, so there is no version or platform to blame and the
 * answer is never "you built it in the wrong place". Saying so explicitly stops
 * a reader reaching for the bundler explanation that fits the neighbouring
 * checks.
 */
export const VERBATIM_NOTICE = [
  "",
  "  This artifact is copied verbatim, not bundled — byte identical on every",
  "  platform and bun version. A mismatch is always a real edit that was not",
  "  re-inlined. Rebuild and commit the result.",
  "",
].join("\n");
