#!/usr/bin/env bun
/**
 * Bundle the EML checker and fixer as two standalone files for the web.
 *
 * `html/checker.js` and `html/fixer.js` are what an author — or a model writing
 * a model — validates a `.eml.mmd` against without a checkout, a Bun install or
 * a terminal. They sit at the site root rather than under `assets/` because
 * their URL is the interface: `website/llmtext/llms-full.txt` tells a language model to
 * run its output past appwithai.org/checker.js, and a path that reads like an
 * implementation detail invites being moved.
 *
 * Two files, not one, because they are two tools and a caller usually wants only
 * the first. The checker duplicated inside `fixer.js` is the price of `fixer.js`
 * being able to re-check what it repaired without a second fetch, which is the
 * loop that makes the repair trustworthy.
 *
 * Nothing here re-implements a rule. Both entry points inject the inlined
 * language definition and re-export the pure functions from `language/checker.ts`
 * and `language/fixer.ts` — the same engines the CLIs run.
 *
 *   bun run build:language-tools
 *   bun run build:language-tools --check    # fail if the checked-in copies are stale
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { bundlerEnvNotice } from "./lib/build-env.ts";

// Pinned to the repository root, not the working directory. Bun labels each
// bundled module with its path relative to the cwd, so a build from anywhere
// else produces a different file — `--check` passing locally and failing on CI,
// which is the worst way round.
const ROOT = resolve(import.meta.dir, "..");
process.chdir(ROOT);

const TOOLS = [
  {
    entry: "language/browser/checker.entry.ts",
    target: "html/checker.js",
    global: "EMLChecker",
    what: "the EML checker",
    blurb:
      "// Every diagnostic `bun language/checker.ts` prints, as a function:\n" +
      "//   import { check, formatReport } from './checker.js';\n" +
      "//   const report = check(source);   // { ok, counts, issues, languageVersion }\n",
  },
  {
    entry: "language/browser/fixer.entry.ts",
    target: "html/fixer.js",
    global: "EMLFixer",
    what: "the EML fixer",
    blurb:
      "// The five repairs `bun language/fixer.ts` applies, plus the check-fix-recheck\n" +
      "// loop that makes them trustworthy:\n" +
      "//   import { checkAndFix } from './fixer.js';\n" +
      "//   const { source, ok, remaining } = checkAndFix(model);\n",
  },
] as const;

/**
 * Stubs for the Node builtins the CLI halves still name.
 *
 * `checker.ts` and `fixer.ts` read files and write `.error` reports when they
 * are commands; `language/index.ts` resolves the definition off disk. The entry
 * points inject the definition and call only the pure functions, so none of
 * these ever run — but the imports must still resolve for the bundle to build.
 *
 * They fail rather than pretend: a read reports a missing file, which is the
 * branch the loader already handles, and a write throws, because a page quietly
 * dropping a write would be worse than one that says it cannot.
 */
const nodeStubs: Record<string, string> = {
  "node:fs":
    "const missing = () => { throw new Error('no filesystem in the browser'); };\n" +
    "export const existsSync = () => false;\n" +
    "export const readFileSync = missing;\n" +
    "export const writeFileSync = missing;\n" +
    "export const readdirSync = missing;\n" +
    "export const statSync = missing;\n" +
    "export default { existsSync, readFileSync, writeFileSync, readdirSync, statSync };",
  "node:path":
    "const dirname = (p) => String(p).replace(/\\/[^/]*$/, '') || '/';\n" +
    "const basename = (p) => String(p).split('/').pop() || '';\n" +
    "const join = (...parts) => parts.filter(Boolean).join('/').replace(/\\/+/g, '/');\n" +
    "const resolve = (...parts) => join(...parts);\n" +
    "const relative = (_from, to) => String(to);\n" +
    "export { dirname, basename, join, resolve, relative };\n" +
    "export default { dirname, basename, join, resolve, relative };",
  "node:url":
    "export const fileURLToPath = (url) => String(url).replace(/^file:\\/\\//, '');\n" +
    "export default { fileURLToPath };",
};

const stubPlugin: import("bun").BunPlugin = {
  name: "node-builtin-stubs",
  setup(build) {
    build.onResolve({ filter: /^node:(fs|path|url)$/ }, (args) => ({
      path: args.path,
      namespace: "node-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "node-stub" }, (args) => ({
      contents: nodeStubs[args.path] ?? "export default {};",
      loader: "js",
    }));
  },
};

const check = process.argv.includes("--check");
let stale = false;

for (const tool of TOOLS) {
  const result = await Bun.build({
    plugins: [stubPlugin],
    entrypoints: [join(ROOT, tool.entry)],
    target: "browser",
    format: "esm",
    minify: false,
    // Readable rather than minified, as with the other bundles in html/: this is
    // served from a documentation site, and someone who wants to know what the
    // page does to their model should be able to read it.
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.EML_DEBUG": "undefined",
      "import.meta.main": "false",
    },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  const artifact = result.outputs[0];
  if (!artifact) {
    console.error(`no output for ${tool.entry}`);
    process.exit(1);
  }

  const banner =
    `// Generated by scripts/build-language-tools.ts — do not edit.\n` +
    `// Source: ${tool.entry}\n` +
    `//\n` +
    `// ${tool.what}, bundled for the browser. This is the engine the CLI runs, not a\n` +
    `// second implementation of it — a document that passes here passes there.\n` +
    `//\n` +
    tool.blurb +
    `//\n` +
    `// Loaded without a bound import, it also answers to globalThis.${tool.global}.\n`;

  const bundle = banner + (await artifact.text());
  const target = join(ROOT, tool.target);

  if (check) {
    const existing = await readFile(target, "utf-8").catch(() => "");
    if (existing !== bundle) {
      console.error(`${tool.target} is out of date.\nRun: bun run build:language-tools`);
      stale = true;
    } else {
      console.log(`✓ ${tool.target} is up to date`);
    }
  } else {
    await mkdir(join(ROOT, "html"), { recursive: true });
    await writeFile(target, bundle, "utf-8");
    console.log(
      `✓ bundled ${tool.what} to ${relative(ROOT, target)} (${(bundle.length / 1024).toFixed(0)}KB)`
    );
  }
}

if (stale) {
  console.error(bundlerEnvNotice(ROOT));
  process.exit(1);
}
