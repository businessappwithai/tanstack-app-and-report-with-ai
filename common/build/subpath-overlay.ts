#!/usr/bin/env bun
/**
 * Put a TanStack Start application on a URL sub-path.
 *
 * Both applications here are served from one origin — the generated one under
 * `/app`, the reporting one under `/report` — and neither was written to live
 * anywhere but the root of a host. Three things have to agree for that to work,
 * and getting one of them wrong produces a blank page rather than an error:
 *
 *   1. the bundler's `base`, so the HTML asks for `/report/assets/x.js` rather
 *      than `/assets/x.js`
 *   2. the router's `basepath`, so a client-side link is built as
 *      `/report/dashboard` and an incoming `/report/dashboard` still matches
 *      the `/dashboard` route
 *   3. any hand-written static-file server in front of the app, which maps a
 *      URL path to a file on disk and will not find `assets/x.js` under a
 *      directory it was told is `/report/assets/x.js`
 *
 * The prefix is deliberately *not* stripped by the proxy in front. Stripping it
 * would satisfy (3) for free and then break (2): the server would receive
 * `/dashboard` while every link the router writes says `/report/dashboard`.
 *
 * Applied to a *copy*: the generated application's output, which this project
 * owns, and the reporting application's source inside its image at build time.
 * Neither checked-in project is modified.
 *
 *   bun build/subpath-overlay.ts --dir <appRoot> --base /report
 *
 * Idempotent — a second run over an already-patched tree changes nothing and
 * says so, because the image build and the local generate both run it.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Patch {
  file: string;
  /** Skip when already applied. */
  done: (src: string) => boolean;
  apply: (src: string, base: string) => string;
  /** A file that simply is not in this flavour of app, rather than a failure. */
  optional?: boolean;
}

const MARKER = "/* subpath-overlay */";

/**
 * Where a Vite config's options object begins, in either of the two shapes the reporting
 * application has used:
 *
 *   export default defineConfig({                      the object form
 *   export default defineConfig(({ mode }) => ({       the function form, which it moved to
 *                                                      when it began reading `mode`
 *
 * The overlay anchored on the first only, so when the reporting application changed shape
 * the image build failed at this step — and nothing here ran it, because the only caller
 * is the Docker build. `check:overlay` holds both.
 */
const VITE_OPTIONS_START =
  /export default defineConfig\(\s*(?:\([^)]*\)\s*=>\s*\(\s*)?\{/;

export const PATCHES: Patch[] = [
  // --- Vite, as the reporting application configures it ---------------------
  {
    file: "vite.config.ts",
    optional: true,
    done: (s) => s.includes(MARKER),
    apply: (s, base) => {
      const found = VITE_OPTIONS_START.exec(s);
      if (!found) {
        throw new Error("vite.config.ts: no defineConfig({ or defineConfig(() => ({ to anchor on");
      }
      const end = found.index + found[0].length;
      return `${s.slice(0, end)}\n  ${MARKER} base: ${JSON.stringify(`${base}/`)},${s.slice(end)}`;
    },
  },

  // --- TanStack Start's own config, as the generated application uses it -----
  //
  // Deliberately NOT patched with a `base`, and the reason is worth keeping.
  //
  // That version of TanStack Start is Vinxi-based: it writes the client bundle
  // to `public/_build/` and the rest to `public/assets/`, and serves `public/`
  // at the server root through Nitro. Setting Vite's `base` rewrote *some*
  // emitted URLs and moved no files and did not touch the `_build` router at
  // all, so a build came out half-prefixed:
  //
  //   /app/assets/globals-*.css   200, and `text/html` — the SPA fallback,
  //                               because nothing is on disk at that path
  //   /_build/assets/client-*.js  emitted un-prefixed, 404 behind the proxy
  //
  // A stylesheet request answered with a page is worse than a 404: the browser
  // reports nothing and the application renders unstyled and inert. So this
  // application keeps its root-absolute asset URLs and the proxy in front routes
  // those namespaces to it — see common/docker/nginx/default.conf. The router
  // basepath below is the half that does work, and is what makes every *link*
  // the application writes carry the prefix.

  // --- The router ------------------------------------------------------------
  {
    file: "src/router.tsx",
    done: (s) => s.includes(MARKER),
    apply: (s, base) => {
      // Two shapes in play: `createRouter({ routeTree })` in the generated app,
      // and a multi-line options object in the reporting app.
      const oneLine = /createRouter\(\{\s*routeTree\s*\}\)/;
      if (oneLine.test(s)) {
        return s.replace(
          oneLine,
          `createRouter({ routeTree, ${MARKER} basepath: ${JSON.stringify(base)} })`
        );
      }
      const multi = "return createRouter({";
      if (!s.includes(multi)) throw new Error("src/router.tsx: no createRouter({ to anchor on");
      return s.replace(multi, `${multi}\n    ${MARKER} basepath: ${JSON.stringify(base)},`);
    },
  },

  // --- The hand-written static server in front of the reporting app ---------
  {
    file: "server-static-wrapper.mjs",
    optional: true,
    done: (s) => s.includes(MARKER),
    apply: (s, base) => {
      const anchor = "    const pathname = url.pathname;";
      if (!s.includes(anchor)) {
        throw new Error(
          "server-static-wrapper.mjs: no `const pathname = url.pathname;` to anchor on"
        );
      }
      // `pathname` keeps the prefix, because the router downstream needs it.
      // Only the two branches that map a URL to a file on disk look at the
      // stripped form.
      return s
        .replace(
          anchor,
          `${anchor}\n    ${MARKER}\n` +
            `    const BASE_PATH = ${JSON.stringify(base)};\n` +
            `    const filePathname = pathname.startsWith(BASE_PATH + '/')\n` +
            `      ? pathname.slice(BASE_PATH.length)\n` +
            `      : pathname;`
        )
        .replace(
          "    if (pathname.startsWith('/assets/')) {",
          "    if (filePathname.startsWith('/assets/')) {"
        )
        .replace(
          "      const relPath = pathname.substring(1);",
          "      const relPath = filePathname.substring(1);"
        )
        .replace(
          "    if (pathname === '/favicon.ico' || pathname === '/icon.svg' || pathname.startsWith('/vs/')) {",
          "    if (filePathname === '/favicon.ico' || filePathname === '/icon.svg' || filePathname.startsWith('/vs/')) {"
        )
        .replace(
          "      const publicPath = resolve(process.cwd(), 'public', pathname.replace(/^\\//, ''));",
          "      const publicPath = resolve(process.cwd(), 'public', filePathname.replace(/^\\//, ''));"
        );
    },
  },
];

/**
 * Rewrite the application's own root-absolute `"/api/…"` literals to sit
 * under the prefix.
 *
 * This is the step that only running the two applications together revealed,
 * and the one without which path-based co-hosting cannot work at all.
 *
 * Vite's `base` rewrites asset URLs. The router's `basepath` rewrites links and
 * route matching. Neither touches a request URL written as a string literal in
 * source — and both applications here call their API that way, root-absolute:
 * 174 call sites in the reporting application, 7 in the generated one. Served
 * side by side they both ask for `/api/...` on the same origin, and no proxy
 * can send one path to two upstreams.
 *
 * So the application that *can* be moved is moved.
 *
 * The rule is "every root-absolute `/api/` literal except a route definition",
 * and it is stated that way round after the narrower one failed. Anchoring on
 * `fetch(` looked safe and missed most of them, because a request URL is very
 * often not written inside the `fetch(` call:
 *
 *     const url = chartId === "new" ? "/api/charts" : `/api/charts/${chartId}`
 *     const url = new URL(`/api/charts/${chartId}/data`, location.origin)
 *     ...createSyncOptions("/api/sync/reports")
 *     downloadUrl: `/api/report-generation/artifacts/${id}?download=true`
 *     <CopilotKit runtimeUrl="/api/copilotkit">
 *
 * Every one of those is a request that leaves the browser for `/api/…` on a
 * shared origin, which the proxy hands to the *other* application. The
 * CopilotKit ones are how this was found: the reporting platform's assistant
 * was asking the generated application's NestJS backend for a completion.
 *
 * `createFileRoute("/api/…")` and `createAPIFileRoute("/api/…")` are the
 * exception, and the only one: those are route *definitions*, which the router
 * already prefixes with its basepath when it matches a request. Rewriting them
 * too would double the prefix.
 *
 * The other application keeps the root, and the proxy routes `/api/` there —
 * see common/docker/nginx/default.conf.
 */
/**
 * Apply one source-level rewrite across `src/**`, returning the file count.
 *
 * Shared by the two rewrites below because they differ only in their pattern:
 * both walk the same tree, skip the same directories, and count files rather
 * than call sites.
 */
function rewriteSources(dir: string, rewrite: (src: string) => string): number {
  const root = path.join(dir, "src");
  if (!existsSync(root)) return 0;
  let changed = 0;

  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      const src = readFileSync(full, "utf8");
      const next = rewrite(src);
      if (next !== src) {
        writeFileSync(full, next);
        changed++;
      }
    }
  };

  walk(root);
  return changed;
}

function rewriteApiCalls(dir: string, base: string): number {
  // A quote or backtick, then /api at a path boundary. The capture keeps
  // whatever preceded it so the negative lookbehind below can be checked
  // against real text rather than guessed at.
  const pattern = /(.{0,24})(["'`])\/api(?=[/"'`?#])/g;
  // A route definition, and nothing else, is left alone.
  const routeDef = /create(?:API)?FileRoute\(\s*$/;

  return rewriteSources(dir, (src) =>
    src.replace(pattern, (whole, before: string, quote: string) =>
      routeDef.test(before) ? whole : `${before}${quote}${base}/api`
    )
  );
}

/**
 * Rewrite `window.location.href = "/…"` and friends to sit under the prefix.
 *
 * The router's `basepath` rewrites every navigation that goes *through the
 * router*. These do not: assigning `location.href` is a full browser
 * navigation, and the string is taken literally. Under a prefix that makes the
 * path wrong, and the proxy has nothing to match — the browser leaves the
 * application entirely and gets the front door's 404.
 *
 * Two call sites in the generated application make this fatal rather than
 * cosmetic, and neither is reachable by clicking:
 *
 *   - the 401 handler in `contexts/auth-context.tsx` sends every unauthenticated
 *     visitor to `/auth/login`. That is the *first* thing that happens to a
 *     first-time visitor, so the whole application is unreachable: `/app/`
 *     answers 200, then the page navigates itself off the prefix and 404s.
 *   - `routes/auth/login.tsx` sends a *successful* sign-in to `/dashboard`,
 *     so even reaching the login form by hand ends the same way.
 *
 * A path that already starts with the base is left alone, so the rewrite is
 * idempotent; `//host/…` is a protocol-relative URL to another origin, not a
 * path, and is skipped too.
 */
function rewriteHardNavigations(dir: string, base: string): number {
  // The leading slash is consumed by the `\/` in the pattern, so the guard
  // that stops a second run double-prefixing has to compare against the base
  // *without* it — "app", not "/app". With the slash the lookahead can never
  // match, and the rewrite silently produces /app/app/… on every re-run.
  const esc = base.replace(/^\//, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    // location.href = "/…"  |  location.replace("/…")  |  location.assign("/…")
    `((?:window\\s*\\.\\s*)?location\\s*\\.\\s*(?:href\\s*=|replace\\(|assign\\()\\s*)` +
      `(["'\`])\\/(?!\\/|${esc}(?:[/"'\`?#]|$))`,
    "g"
  );
  return rewriteSources(dir, (src) => src.replace(pattern, `$1$2${base}/`));
}

function main(): number {
  const argv = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = flag("--dir");
  const base = (flag("--base") ?? "").replace(/\/+$/, "");

  if (!dir || !base || !base.startsWith("/")) {
    console.error("usage: subpath-overlay.ts --dir <appRoot> --base /report");
    return 2;
  }
  if (!existsSync(dir)) {
    console.error(`No such directory: ${dir}`);
    return 2;
  }

  let applied = 0;
  let already = 0;
  let missing = 0;

  for (const patch of PATCHES) {
    const file = path.join(dir, patch.file);
    if (!existsSync(file)) {
      if (patch.optional) {
        missing++;
        continue;
      }
      console.error(`  FAIL  ${patch.file} not found under ${dir}`);
      return 1;
    }
    const src = readFileSync(file, "utf8");
    if (patch.done(src)) {
      already++;
      continue;
    }
    try {
      writeFileSync(file, patch.apply(src, base));
      console.log(`  base ${base}  ${patch.file}`);
      applied++;
    } catch (err) {
      console.error(`  FAIL  ${patch.file}: ${err instanceof Error ? err.message : err}`);
      return 1;
    }
  }

  // Only the application that carries a real Vite `base` gets its API calls
  // moved. The generated application keeps the root `/api` — its framework
  // cannot be prefixed (see the note on app.config.ts above), so it is the one
  // the proxy leaves at the root.
  if (existsSync(path.join(dir, "vite.config.ts"))) {
    const rewritten = rewriteApiCalls(dir, base);
    if (rewritten > 0) {
      console.log(`  base ${base}  ${rewritten} file(s) with "/api…" request URLs`);
      applied += rewritten;
    }
  }

  // Both applications get this one. A hard navigation bypasses the router
  // whichever application writes it, so `basepath` cannot save either.
  const navs = rewriteHardNavigations(dir, base);
  if (navs > 0) {
    console.log(`  base ${base}  ${navs} file(s) with window.location navigations`);
    applied += navs;
  }

  // A run that patched nothing at all is the failure this reports: it means
  // every anchor moved, and the app would build and then 404 its own assets.
  if (applied === 0 && already === 0) {
    console.error(`  FAIL  nothing to patch under ${dir} — ${missing} file(s) absent`);
    return 1;
  }
  console.log(`  ${applied} patched, ${already} already at ${base}, ${missing} not applicable`);
  return 0;
}

if (import.meta.main) process.exit(main());
