#!/usr/bin/env bun
/**
 * The sub-path overlay still finds what it patches.
 *
 * `build/subpath-overlay.ts` rewrites two other projects' source by looking for fixed
 * anchors in it. Nothing runs it except the reporting image's Docker build, so when that
 * project changed the shape of its `vite.config.ts` the build broke and no check here
 * noticed — the first sign was a failed image, a long way from the cause.
 *
 * This runs the real patches over the shapes the anchors have to handle, and over the
 * reporting checkout's own files when it is placed. The fixtures are small on purpose:
 * each one is a line of source an anchor depends on.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PATCHES } from "../build/subpath-overlay";

const BASE = "/report";
let failures = 0;
const fail = (message: string): void => {
  failures++;
  console.error(`  FAIL  ${message}`);
};
const ok = (message: string): void => console.log(`  ok    ${message}`);

const vite = PATCHES.find((patch) => patch.file === "vite.config.ts");
if (!vite) throw new Error("no vite.config.ts patch in the overlay");

const VITE_SHAPES: Record<string, string> = {
  "object form": "export default defineConfig({\n  plugins: [],\n})\n",
  "function form": "export default defineConfig(({ mode }) => ({\n  define: {},\n  plugins: [],\n}))\n",
  "function form, one parameter": "export default defineConfig((env) => ({\n  plugins: [],\n}))\n",
  "function form, spaced": "export default defineConfig( ({ mode }) =>  ( {\n  plugins: [],\n}))\n",
};

for (const [name, source] of Object.entries(VITE_SHAPES)) {
  try {
    const patched = vite.apply(source, BASE);
    if (!patched.includes('base: "/report/"')) fail(`vite.config.ts, ${name}: no base in the result`);
    else if (!vite.done(patched)) fail(`vite.config.ts, ${name}: not recognised as patched afterwards`);
    else ok(`vite.config.ts, ${name}`);
  } catch (error) {
    fail(`vite.config.ts, ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

try {
  vite.apply("export default { plugins: [] }\n", BASE);
  fail("vite.config.ts with no defineConfig was patched — it should have refused");
} catch {
  ok("vite.config.ts with no defineConfig is refused, not skipped");
}

// The reporting application's own files, when its checkout is here (./deps.sh places it).
const reporting = path.resolve(import.meta.dir, "../../enterprise_reporting_tanstack");
if (existsSync(reporting)) {
  for (const patch of PATCHES) {
    const file = path.join(reporting, patch.file);
    if (!existsSync(file)) {
      if (patch.optional) continue;
      fail(`${patch.file}: not in the reporting checkout`);
      continue;
    }
    try {
      const patched = patch.apply(readFileSync(file, "utf8"), BASE);
      if (patched.length === 0 || !patch.done(patched)) fail(`${patch.file} (reporting checkout): not patched`);
      else ok(`${patch.file} (reporting checkout)`);
    } catch (error) {
      fail(`${patch.file} (reporting checkout): ${error instanceof Error ? error.message : error}`);
    }
  }
} else {
  console.log("  --    reporting checkout not placed (./deps.sh) — only the fixtures were checked");
}

if (failures > 0) {
  console.error(`\n${failures} overlay check(s) failed.`);
  process.exit(1);
}
console.log("\nThe overlay finds every anchor it needs.");
