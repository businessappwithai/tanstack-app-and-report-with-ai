#!/usr/bin/env bun
/**
 * The front door: one page, two applications, both sign-ins.
 *
 *   bun build/landing.ts -i <pack.json> -o <dir> [--origin http://localhost]
 *
 * `/` used to redirect to `/app`, under a comment in the nginx config saying
 * "Nothing is served at the root: this origin is two applications, and guessing
 * which one somebody meant is worse than saying so" — and then guessing. The
 * consequence was not cosmetic: a reader who did not scroll back through the
 * terminal never learned `/report` existed at all, and the reporting platform
 * that had just been built, seeded and attached to their application was
 * invisible.
 *
 * So the root says what is here instead. Two cards, each naming an application,
 * what it is for, and the accounts it signs in with — because the two are
 * genuinely separate systems and that is the thing most likely to be got wrong:
 *
 *   - separate databases (`appdb` and `enterprise_config`)
 *   - separate user tables, separate sessions, separate sign-in screens
 *   - roles that share a *name* and mean different things. In the application a
 *     role decides what a user may do to a record; on the reporting side the
 *     same name decides which tables their queries may read
 *
 * The page is generated rather than static because every account on it comes
 * from the model: a model with nine `%%rbac` roles produces nine pairs, and one
 * with none produces the two administrators. It carries no JavaScript and no
 * network calls — it is a signpost, and a signpost that can fail to load is
 * worse than a redirect.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface AccessRoleSpec {
  name: string;
  declaredAs: string;
  description: string;
  isAdmin: boolean;
  email: string;
  appEmail: string;
  tables: string[];
}

interface Pack {
  application: { name: string; description: string; model: string; databaseName: string };
  queries: unknown[];
  reports: unknown[];
  charts: unknown[];
  dashboards: unknown[];
  access?: {
    roles: AccessRoleSpec[];
    scoped: boolean;
    entityTotal?: number;
    appPassword?: string;
    reportPassword?: string;
  };
}

const esc = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The account table.
 *
 * One row per role, both addresses side by side, so the question the page
 * exists to answer — "which of these do I type where?" — is answered by the
 * layout rather than by prose. The table count is on the reporting address
 * because that is the side where it means something: it is how many tables that
 * role's queries may read.
 */
function accountRows(roles: AccessRoleSpec[], entityTotal: number): string {
  return roles
    .map((role) => {
      const scope = role.isAdmin ? "every table" : `${role.tables.length} of ${entityTotal} tables`;
      return `        <tr${role.isAdmin ? ' class="is-admin"' : ""}>
          <th scope="row">${esc(role.name)}</th>
          <td><code>${esc(role.appEmail)}</code></td>
          <td><code>${esc(role.email)}</code><span class="scope">${esc(scope)}</span></td>
        </tr>`;
    })
    .join("\n");
}

export function renderLanding(pack: Pack, origin: string, chat = false): string {
  const roles = pack.access?.roles ?? [];
  // Stated by the pack. The fallback is for a pack built before it was, and
  // widens to the broadest role rather than claiming a total it cannot know.
  const entityTotal =
    pack.access?.entityTotal ?? roles.reduce((max, role) => Math.max(max, role.tables.length), 0);
  const app = pack.application;
  // Stated by the pack, per side, because they differ. The fallbacks are for a
  // pack built before that was carried.
  const appPassword = pack.access?.appPassword ?? "admin123";
  const reportPassword = pack.access?.reportPassword ?? "admin";
  const counts = `${pack.reports.length} reports · ${pack.charts.length} charts · ${pack.dashboards.length} dashboards`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(app.name)}</title>
<style>
  :root {
    --bg: #0f1115; --surface: #171a21; --surface-2: #1e222b; --border: #2a2f3a;
    --text: #e6e9ef; --text-soft: #a6adbb; --text-faint: #6f7787;
    --accent: #6aa9ff; --accent-2: #4ec9a5;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f7f9; --surface: #fff; --surface-2: #f0f2f5; --border: #dfe3ea;
      --text: #16191f; --text-soft: #4a5160; --text-faint: #79808f;
      --accent: #1f6feb; --accent-2: #1a7f64;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 48px 24px 72px; background: var(--bg); color: var(--text);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 940px; margin: 0 auto; }
  h1 { margin: 0 0 6px; font-size: 26px; font-weight: 650; letter-spacing: -0.01em; }
  .sub { margin: 0 0 34px; color: var(--text-soft); font-size: 14.5px; }
  .doors { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 34px; }
  @media (max-width: 720px) { .doors { grid-template-columns: 1fr; } }
  .door {
    display: block; padding: 20px 22px; background: var(--surface); color: inherit;
    border: 1px solid var(--border); border-radius: 12px; text-decoration: none;
    transition: border-color .15s, transform .15s;
  }
  .door:hover { border-color: var(--accent); transform: translateY(-1px); }
  .door h2 { margin: 0 0 4px; font-size: 17px; font-weight: 640; }
  .door .path { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--accent); }
  .door p { margin: 10px 0 0; color: var(--text-soft); font-size: 13.5px; }
  .door .meta { margin-top: 12px; font-size: 12.5px; color: var(--text-faint); }
  .note {
    padding: 14px 18px; margin-bottom: 26px; border-radius: 10px;
    background: var(--surface-2); border: 1px solid var(--border);
    font-size: 13.5px; color: var(--text-soft);
  }
  .note b { color: var(--text); font-weight: 600; }
  h3 { margin: 0 0 10px; font-size: 14px; font-weight: 640; }
  table { width: 100%; border-collapse: collapse; background: var(--surface);
          border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  caption { text-align: left; padding: 0 0 10px; color: var(--text-faint); font-size: 12.5px; }
  th, td { text-align: left; padding: 9px 14px; border-top: 1px solid var(--border); vertical-align: top; }
  thead th { border-top: 0; background: var(--surface-2); font-size: 12px; font-weight: 600;
             text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); }
  tbody th { font-weight: 560; font-size: 13.5px; white-space: nowrap; }
  code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text); }
  .scope { display: block; margin-top: 2px; font-size: 11.5px; color: var(--text-faint); }
  tr.is-admin td, tr.is-admin th { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  .pw { margin-top: 12px; font-size: 12.5px; color: var(--text-faint); }
  .pwhead { display: block; margin-top: 3px; font-weight: 400; text-transform: none;
            letter-spacing: 0; font-size: 11.5px; }
  footer { margin-top: 30px; font-size: 12.5px; color: var(--text-faint); }
</style>
</head>
<body>
<main>
  <h1>${esc(app.name)}</h1>
  <p class="sub">${esc(app.description)}</p>

  <div class="doors">
    <a class="door" href="/app/">
      <h2>The application</h2>
      <span class="path">${esc(origin)}/app</span>
      <p>Generated from <code>${esc(app.model)}</code> — its entities, rules, workflows and access control, with the records people create and change.</p>
      <span class="meta">Its own database (<code>${esc(app.databaseName)}</code>) and its own sign-in.</span>
    </a>
    <a class="door" href="/report/">
      <h2>The reports</h2>
      <span class="path">${esc(origin)}/report</span>
      <p>The reporting platform, already holding that database as a data source with its schema introspected and a reporting layer built from the same model.</p>
      <span class="meta">${esc(counts)} · a separate database and a separate sign-in.</span>
    </a>${
      chat
        ? `
    <a class="door" href="/chat/">
      <h2>The assistant</h2>
      <span class="path">${esc(origin)}/chat</span>
      <p>Both of the above, by asking: find a record or a report and it opens beside the conversation. What you can reach is what your application account can reach.</p>
      <span class="meta">Sign in with an <b>application</b> account. It has no accounts of its own.</span>
    </a>`
        : ""
    }
  </div>

  <div class="note">
    <b>These are two systems, not two pages.</b> Separate databases, separate user
    tables, separate sessions. A role name appears on both sides and means a
    different thing on each: in the application it decides what you may
    <em>do</em> to a record; in the reporting platform it decides which tables
    your queries may <em>read</em>. Signing into one does not sign you into the
    other${roles.length > 0 ? ", and the addresses differ so that is hard to get wrong" : ""}.
  </div>

${
  roles.length > 0
    ? `  <h3>Accounts</h3>
  <table>
    <caption>One pair per role the model declares. The two sides seed different passwords.</caption>
    <thead>
      <tr>
        <th>Role</th>
        <th>Application &mdash; /app<span class="pwhead">password <code>${esc(appPassword)}</code></span></th>
        <th>Reports &mdash; /report<span class="pwhead">password <code>${esc(reportPassword)}</code></span></th>
      </tr>
    </thead>
    <tbody>
${accountRows(roles, entityTotal)}
    </tbody>
  </table>
  <p class="pw">The two administrators share an address, <code>admin@admin.com</code>, and are
  still two different accounts in two different databases &mdash; with two
  different passwords, as above.</p>`
    : `  <div class="note">This model declares no <code>%%rbac</code> roles, so each side has
  only its administrator, <code>admin@admin.com</code> &mdash; <code>${esc(appPassword)}</code>
  on the application, <code>${esc(reportPassword)}</code> on the reports.</div>`
}

  <footer>Generated from ${esc(app.model)}. Stop everything with <code>./stop.sh</code>.</footer>
</main>
</body>
</html>
`;
}

function main(): number {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const input = flag("-i") ?? flag("--input");
  const output = flag("-o") ?? flag("--output") ?? ".";
  const origin = flag("--origin") ?? "http://localhost";
  const chat = argv.includes("--chat");

  if (!input) {
    console.error("usage: landing.ts -i <pack.json> [-o dir] [--origin http://localhost] [--chat]");
    return 2;
  }
  if (!existsSync(input)) {
    console.error(`Pack not found: ${input}`);
    return 2;
  }

  const pack: Pack = JSON.parse(readFileSync(input, "utf8"));
  mkdirSync(path.resolve(output), { recursive: true });
  const target = path.join(path.resolve(output), "index.html");
  writeFileSync(target, renderLanding(pack, origin, chat));

  const roles = pack.access?.roles.length ?? 0;
  console.log(`  front door: ${roles} role(s), both sign-ins`);
  console.log(`  → ${target}`);
  return 0;
}

if (import.meta.main) process.exit(main());
