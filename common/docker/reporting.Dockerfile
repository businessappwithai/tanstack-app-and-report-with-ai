# The reporting application, built to live under /report.
#
# Its own Dockerfile is checked in next door and is left exactly as it is: this
# one builds the same source with two differences that only matter when the app
# shares an origin with another.
#
#   1. `common/build/subpath-overlay.ts` is run over the source before the
#      build, setting the bundler's `base`, the router's `basepath` and the
#      static wrapper's file lookup to /report. See that file for why all three
#      are needed and why the proxy in front does not strip the prefix.
#   2. The seeder's dependencies are carried into the runtime image. It runs
#      from source and resolves through `@/`, so the whole of `src/` comes
#      across — see the note on that COPY for why it is not the handful of
#      directories it imports today.
#
# The overlay writes into the build container's copy. Nothing under
# enterprise_reporting_tanstack/ is modified.

# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.4 AS builder

WORKDIR /app

COPY . .
# `bun install`, not `bun install --frozen-lockfile`, and that is not a
# preference.
#
# `bun.lock` at enterprise_reporting_tanstack@main disagrees with the
# `package.json` beside it: the lock still carries `falkordb` and its subtree
# (`@js-temporal/polyfill`, `jsbi`, `generic-pool`), which the manifest no
# longer depends on. Bun refuses a frozen install against that — under every
# version tried, and in that repository's own Dockerfile as much as this one. A frozen install here would fail every build, not catch drift.
#
# Reproducibility does not rest on this line anyway: the orchestrator pins the
# commit each repository is built from (APP_REPO_REF / REPORT_REPO_REF), so a
# build names its sources exactly. Restore --frozen-lockfile the moment
# upstream regenerates the lock.
RUN bun install && bun pm cache rm

# The overlay, from the `common` build context declared in docker-compose.yml.
COPY --from=common build/subpath-overlay.ts /overlay/subpath-overlay.ts
ARG BASE_PATH=/report
RUN bun /overlay/subpath-overlay.ts --dir /app --base "${BASE_PATH}"

RUN bun run build

# ─── runtime ────────────────────────────────────────────────────────────────
FROM oven/bun:1.4.4-slim

WORKDIR /app

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/bun.lock ./bun.lock
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# The patched wrapper, not the original: it is the copy that knows the prefix.
COPY --from=builder /app/server-static-wrapper.mjs ./server-static-wrapper.mjs

# src/, so the seeder uses this project's own encryption, schema introspection
# and cache shape rather than a second implementation of each.
#
# The whole directory, not the five that `scripts/seed-reporting-pack.ts`
# imports today. That list was kept by hand and it went stale the first time
# the platform added an import to a file already on it: `src/lib/db/bootstrap.ts`
# began importing `@/lib/auth/bcrypt-cost`, nothing copied `src/lib/auth`, and
# the seeder exited 1 on `Cannot find module` — after the image had built and
# the platform had started serving, because nothing here resolves `@/` until
# the seeder runs. `src/` is about four megabytes beside a `node_modules`
# already copied above, and the enumeration bought nothing but that failure.
COPY --from=builder /app/src ./src

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    PUBLIC_DIR=/app/dist/client

# The probe is bun rather than curl, and that is the reason there is no
# apt-get in this file at all. `oven/bun:1.4.4-slim` ships no curl, no
# ca-certificates and no psql, and the three lines that used to install them
# bought one healthcheck: nothing here shells out to psql — the `pg_isready`
# probes in docker-compose.yml run inside the postgres images, which have it —
# and bun carries its own root certificates, so the system store is unused.
# An apt layer is also the first thing to fail on a network that does not allow
# deb.debian.org, which is a poor way to lose a build that needs no packages.
#
# 127.0.0.1, never localhost: inside the container localhost also resolves to
# ::1, and the server listens on IPv4 only — the probe then reports "connection
# refused" against a server answering 200 to everyone else.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=12 \
    CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:3000/api/health').catch(() => null); process.exit(r?.ok ? 0 : 1)"]

CMD ["bun", "server-static-wrapper.mjs"]
