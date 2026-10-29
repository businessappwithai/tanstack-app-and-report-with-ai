#!/usr/bin/env bun
/**
 * Prove the derived reporting pack actually runs against the schema the
 * generator emits.
 *
 * For each model: generate the application, apply its `bus_` migrations to a
 * real PostgreSQL, derive the reporting pack, and execute every query in it.
 *
 * This is the only check that can catch the class of bug the pack is most
 * exposed to. `reporting-pack.ts` builds SQL from a *parsed model*, while the
 * tables come from a *separate compiler* in another project; nothing type-checks
 * one against the other. A column the generator renames, a foreign key it
 * places on the other side of a relationship, an audit column it stops
 * emitting — each leaves the pack building cleanly and every report failing at
 * run time, in an application the person who wrote the model never sees fail.
 *
 * It found one on its first run: the parser's `relationship.foreignKey` names
 * the *target* entity's own id, so `Team ||--o{ User` reads `user_id` rather
 * than the `team_id` column the migration actually creates. Every
 * children-per-parent report was silently absent.
 *
 *   PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=postgres bun scripts/check-reporting-pack.ts
 *
 * Skips itself with a clear message when no PostgreSQL is reachable, so a
 * checkout without one still runs the rest of `bun run check:all`. Pass
 * `--require-server` to make that a failure instead: CI does, because a check
 * that quietly passes when its database never came up is indistinguishable
 * from one that ran, and the whole point of this file is to not be that.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPack } from "../build/reporting-pack.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const MODELS = ["language/examples", "examples"];

const PG = {
  host: process.env.PGHOST ?? "/var/run/postgresql",
  port: process.env.PGPORT ?? "5432",
  user: process.env.PGUSER ?? "postgres",
};

function psql(args: string[], database: string): { ok: boolean; out: string } {
  const r = spawnSync(
    "psql",
    ["-h", PG.host, "-p", PG.port, "-U", PG.user, "-d", database, "-tA", ...args],
    { encoding: "utf8", env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? "" } }
  );
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function serverReachable(): boolean {
  return psql(["-c", "select 1"], "postgres").ok;
}

/**
 * The `up()` half of every generated migration, as raw SQL.
 *
 * The migrations are Kysely modules, and running them properly would mean
 * installing the generated project. Their DDL is plain `sql` template literals,
 * so it is lifted out and replayed directly — the tables are what this check
 * needs, not the migration runner.
 */
function schemaSql(appDir: string): string {
  const dir = path.join(appDir, "backend/src/migrations");
  if (!existsSync(dir)) throw new Error(`No migrations at ${dir}`);
  const statements: string[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(path.join(dir, file), "utf8");
    const up = src.split("export async function down")[0] ?? src;
    for (const m of up.matchAll(/sql`(.*?)`\s*\.execute\(/gs)) {
      const body = (m[1] ?? "").trim();
      if (body) statements.push(body);
    }
  }
  return `${statements.join(";\n")};\n`;
}

function models(): string[] {
  return MODELS.flatMap((dir) => {
    const abs = path.join(ROOT, dir);
    if (!existsSync(abs)) return [];
    return (
      readdirSync(abs)
        .filter((f) => f.endsWith(".eml.mmd"))
        // PACK_ONLY=wealth runs the models whose file name contains it — for iterating
        // on one model's %%report SQL without regenerating every other model first.
        .filter((f) => !process.env.PACK_ONLY || f.includes(process.env.PACK_ONLY))
        .sort()
        .map((f) => path.join(dir, f))
    );
  });
}

function main(): number {
  const requireServer = process.argv.includes("--require-server");

  if (!serverReachable()) {
    if (requireServer) {
      console.error(
        `  FAIL  no PostgreSQL at ${PG.host}:${PG.port}, and --require-server was passed.`
      );
      console.error(
        "        Nothing was checked. If the service is meant to be up, that is the failure."
      );
      return 1;
    }
    console.log(`  skip  no PostgreSQL at ${PG.host}:${PG.port} — reporting-pack SQL not executed`);
    console.log(
      "        set PGHOST/PGPORT/PGUSER to run it, or pass --require-server to fail instead"
    );
    return 0;
  }

  let failed = 0;
  let executed = 0;

  for (const model of models()) {
    const name = path.basename(model).replace(/\.eml\.mmd$/, "");
    const db = `pack_${name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
    const out = mkdtempSync(path.join(tmpdir(), `pack-${name}-`));

    try {
      const gen = spawnSync(
        "bun",
        [
          "language/cli/eml.ts",
          "generate",
          "-i",
          model,
          "-o",
          out,
          "--stack",
          "tanstack-nestjs",
          "--force",
        ],
        { cwd: ROOT, encoding: "utf8" }
      );
      if (gen.status !== 0) {
        failed++;
        console.error(`  FAIL  ${name} — generate exited ${gen.status}`);
        console.error(`${gen.stdout ?? ""}${gen.stderr ?? ""}`.replace(/^/gm, "        "));
        continue;
      }

      psql(["-c", `DROP DATABASE IF EXISTS ${db}`], "postgres");
      const created = psql(["-c", `CREATE DATABASE ${db}`], "postgres");
      if (!created.ok) {
        failed++;
        console.error(`  FAIL  ${name} — could not create ${db}: ${created.out.trim()}`);
        continue;
      }

      const sqlFile = path.join(out, "__schema.sql");
      writeFileSync(sqlFile, schemaSql(out));
      // ON_ERROR_STOP off deliberately: the extraction above lifts DDL only,
      // so statements depending on a seed or a function it skipped will fail.
      // The assertion that matters is the table count below.
      psql(["-f", sqlFile], db);

      const tables = psql(
        ["-c", "select count(*) from information_schema.tables where table_name like 'bus\\_%'"],
        db
      );
      const busTables = Number(tables.out.trim());
      const pack = buildPack(readFileSync(path.join(ROOT, model), "utf8"), model, db);
      // Derived keys are `<table>__<kind>`; authored ones are `authored__<name>`
      // and name no table, so counting them would demand a `bus_authored`.
      const entities = new Set(
        pack.queries.map((q) => q.key.split("__")[0]).filter((prefix) => prefix !== "authored")
      ).size;

      if (busTables < entities) {
        failed++;
        console.error(
          `  FAIL  ${name} — ${busTables} bus_ tables for ${entities} entities in the pack`
        );
        continue;
      }

      const bad: string[] = [];
      for (const q of pack.queries) {
        const r = psql(["-v", "ON_ERROR_STOP=1", "-c", q.sql], db);
        executed++;
        if (!r.ok) bad.push(`${q.key}: ${r.out.trim().split("\n")[0]}`);
      }

      if (bad.length > 0) {
        failed++;
        console.error(`  FAIL  ${name} — ${bad.length} of ${pack.queries.length} queries failed`);
        for (const b of bad.slice(0, 5)) console.error(`          ${b}`);
      } else {
        console.log(
          `  ok    ${name.padEnd(42)} ${String(pack.queries.length).padStart(3)} queries · ${busTables} tables`
        );
      }
      if (!process.env.PACK_KEEP) psql(["-c", `DROP DATABASE IF EXISTS ${db}`], "postgres");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  if (failed) {
    console.error(`\n${failed} model(s) failed.`);
    return 1;
  }
  // Reaching the end having executed nothing is not a pass. It means every
  // model was skipped, or the model directories were empty, and the summary
  // line below would read "0 derived queries ran" in a green job.
  if (executed === 0) {
    console.error("\n  FAIL  no queries were executed — nothing was checked.");
    return 1;
  }
  console.log(`\n${executed} derived queries ran against real generated schemas.`);
  return 0;
}

process.exit(main());
