#!/usr/bin/env bun

/**
 * EML Language Fixer
 * ==================
 * Reads a .mmd.error file produced by checker.ts, applies every auto-fixable
 * correction directly to the source .mmd file, then re-runs checker.ts so you
 * can immediately see whether the file is now clean.
 *
 * Usage:
 *   bun language/fixer.ts <file.mmd.error>   # fix one error file
 *   bun language/fixer.ts <file.mmd>          # fix the .mmd (derives error file name)
 *   bun language/fixer.ts examples/           # fix all .mmd.error files in directory
 *
 * Options:
 *   --dry-run    Show what would change, but do NOT write files
 *   --no-recheck Do NOT run checker.ts after fixing
 *   --json       Machine-readable diff output
 *   -h, --help   Show this help
 *
 * Auto-fixable error codes:
 *   EML001  Missing %%meta name → insert %%meta name: <derived>
 *   EML114  FK not ending in _id → append the suffix (_by columns then resolve
 *           to the user entity instead of degrading to a plain string)
 *   EML112  Duplicate attribute → delete the later line, moving any constraint
 *           it carried onto the line that stays
 *   EML103  A column the generator adds anyway → delete the line
 *   EML117  No primary key → prepend  string id PK  to entity block
 *   EML421  State workflow: no [*] → FirstState → insert initial transition
 *   EML422  State workflow: no terminal state → append LastState --> [*]
 *   EML172  Columns no %%section row places → append them to the entity's last
 *           section, two per row
 *   EML174  A %%section row of three or more columns → split it into rows of two
 *   EML175  A column placed in two %%section rows → remove the later placement
 *   EML178  The state field placed in a %%section row → remove it (the state is
 *           shown read-only in the form's header); a section left empty goes too
 *   EML512  A move rule or saga an action button replaces → remove the section,
 *           and rewrite the stock help on the <state>_at columns it left behind
 *
 * All other codes are reported but left for the developer to fix manually.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isPersonRoleColumn } from "./checker";
import { rewriteStockHelp, sectionSpan } from "./move-facts";
import { formatRows, parseRows } from "./sections";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const useColor =
  typeof process !== "undefined" &&
  !process.env?.NO_COLOR &&
  Boolean(process.stdout?.isTTY) &&
  !hasFlag("--no-color");
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};

function hasFlag(name: string): boolean {
  return typeof process !== "undefined" && (process.argv?.includes(name) ?? false);
}

// ---------------------------------------------------------------------------
// Error file types (must match checker.ts output shape)
// ---------------------------------------------------------------------------

export interface Issue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  line?: number;
  hint?: string;
  context?: string;
  autoFixable: boolean;
}

interface ErrorFile {
  file: string;
  checkedAt: string;
  languageVersion: string;
  summary: { errors: number; warnings: number; infos: number; ok: boolean };
  issues: Issue[];
}

// ---------------------------------------------------------------------------
// Per-code fix strategies
// ---------------------------------------------------------------------------

export interface FixResult {
  code: string;
  applied: boolean;
  description: string;
  /** Lines changed in source (for diff display). */
  changes: Array<{
    lineNo: number;
    before: string;
    after: string;
    action: "insert" | "replace" | "delete";
  }>;
}

/**
 * Apply every fix the checker marked auto-fixable, to a document in memory.
 *
 * The rest of this file is about files: reading an `.error` report, writing the
 * repaired `.mmd` back, re-running the checker in a subprocess. None of that can
 * happen in a browser tab, and none of it is the repair — which is a string in
 * and a string out. Exported so the WASM generator can offer the same fixes
 * before it refuses a model.
 */
export function applyFixes(
  source: string,
  issues: Issue[]
): { newSource: string; results: FixResult[] } {
  const lines = source.split("\n");
  const results: FixResult[] = [];
  const fixableIssues = issues.filter((i) => i.autoFixable);

  if (fixableIssues.length === 0) {
    return { newSource: source, results };
  }

  // Sort fixes by line number descending so insertions don't shift later line numbers
  const sorted = [...fixableIssues].sort((a, b) => (b.line ?? 0) - (a.line ?? 0));

  for (const issue of sorted) {
    const result = applyFix(lines, issue);
    results.push(result);
  }

  return { newSource: lines.join("\n"), results };
}

function applyFix(lines: string[], issue: Issue): FixResult {
  const base: FixResult = { code: issue.code, applied: false, description: "", changes: [] };

  switch (issue.code) {
    case "EML001":
      return fixMissingMetaName(lines, issue, base);
    case "EML114":
      return fixForeignKeyNaming(lines, issue, base);
    case "EML112":
      return fixDuplicateAttribute(lines, issue, base);
    case "EML103":
      return fixManagedColumn(lines, issue, base);
    case "EML117":
      return fixMissingPrimaryKey(lines, issue, base);
    case "EML421":
      return fixMissingInitialTransition(lines, issue, base);
    case "EML422":
      return fixMissingTerminalTransition(lines, issue, base);
    case "EML287":
      return fixCamelCaseRuleCondition(lines, issue, base);
    case "EML172":
      return fixUnplacedColumns(lines, issue, base);
    case "EML174":
      return fixWideRow(lines, issue, base);
    case "EML175":
      return fixDoublePlacement(lines, issue, base);
    case "EML178":
      return fixPlacedStateField(lines, issue, base);
    case "EML512":
      return fixRetiredMove(lines, issue, base);
    default:
      base.description = `No auto-fix strategy for ${issue.code}.`;
      return base;
  }
}

// ---------------------------------------------------------------------------
// Fix: EML172, EML174, EML175 — %%section rows
//
// All three rewrite the `rows:` value of one %%section line and nothing else,
// so no line is inserted or removed and the line numbers of every other fix in
// the same run stay true. The rows are read and written by language/sections.ts
// — the same reading the checker and the generator use.
// ---------------------------------------------------------------------------

/** The `rows:` value of a %%section line: where it starts and ends in the text. */
function rowsSpan(text: string): { start: number; end: number } | undefined {
  if (!/^\s*%%section\b/i.test(text)) return undefined;
  const open = text.match(/(^|;)\s*rows\s*:/i);
  if (open?.index === undefined) return undefined;
  const start = open.index + open[0].length;
  const rest = text.slice(start);
  const close = rest.match(/;\s*(entity|name|help|collapsed)\s*:/i);
  return { start, end: close?.index === undefined ? text.length : start + close.index };
}

/** Replace the rows of a %%section line, keeping everything around them. */
function rewriteRows(
  lines: string[],
  issue: Issue,
  base: FixResult,
  change: (rows: string[][]) => string[][] | undefined,
  description: string
): FixResult {
  const index = (issue.line ?? 0) - 1;
  const before = lines[index];
  const span = before === undefined ? undefined : rowsSpan(before);
  if (before === undefined || !span) {
    base.description = `Line ${issue.line ?? "?"} is not a %%section with rows:; left alone.`;
    return base;
  }
  const rows = change(parseRows(before.slice(span.start, span.end)));
  if (!rows) {
    base.description = `Nothing to change on line ${issue.line}.`;
    return base;
  }
  const after = `${before.slice(0, span.start)} ${formatRows(rows)}${before.slice(span.end)}`;
  lines[index] = after;
  base.applied = true;
  base.description = description;
  base.changes = [{ lineNo: index + 1, before, after, action: "replace" }];
  return base;
}

function fixUnplacedColumns(lines: string[], issue: Issue, base: FixResult): FixResult {
  const match = issue.message.match(/^(\w+) leaves \d+ columns? out of every %%section: (.+)\.$/);
  if (!match?.[2]) {
    base.description = "Could not read the unplaced columns from the issue message.";
    return base;
  }
  const columns = match[2].split(",").map((column) => column.trim()).filter(Boolean);
  const added: string[][] = [];
  for (let i = 0; i < columns.length; i += 2) added.push(columns.slice(i, i + 2));
  return rewriteRows(
    lines,
    issue,
    base,
    (rows) => [...rows, ...added],
    `Placed ${columns.join(", ")} in ${match[1]}'s last section, two per row — move them to where they belong.`
  );
}

function fixWideRow(lines: string[], issue: Issue, base: FixResult): FixResult {
  return rewriteRows(
    lines,
    issue,
    base,
    (rows) => {
      if (!rows.some((row) => row.length > 2)) return undefined;
      return rows.flatMap((row) => {
        const pairs: string[][] = [];
        for (let i = 0; i < row.length; i += 2) pairs.push(row.slice(i, i + 2));
        return pairs;
      });
    },
    "Split a row of more than two columns into rows of two."
  );
}

function fixDoublePlacement(lines: string[], issue: Issue, base: FixResult): FixResult {
  const match = issue.message.match(/^"\w+\.(\w+)" is placed in two %%section rows\.$/);
  const column = match?.[1];
  if (!column) {
    base.description = "Could not read the column from the issue message.";
    return base;
  }
  return rewriteRows(
    lines,
    issue,
    base,
    (rows) => {
      /* The issue's line is the later placement. Remove the last occurrence on
         it, which is the duplicate whether the first placement is on this line
         or an earlier one. */
      let rowIndex = -1;
      let colIndex = -1;
      rows.forEach((row, r) =>
        row.forEach((name, c) => {
          if (name === column) {
            rowIndex = r;
            colIndex = c;
          }
        })
      );
      if (rowIndex < 0) return undefined;
      const next = rows.map((row) => [...row]);
      next[rowIndex]?.splice(colIndex, 1);
      return next.filter((row) => row.length > 0);
    },
    `Removed the second placement of "${column}".`
  );
}

/**
 * EML178: the state field is shown read-only in the form's header, so a row
 * that places it is removed from the row. A section whose only column it was
 * would be a heading over nothing, so that line goes as well.
 */
function fixPlacedStateField(lines: string[], issue: Issue, base: FixResult): FixResult {
  const match = issue.message.match(/^%%section places "\w+\.(\w+)", the state field/);
  const column = match?.[1];
  if (!column) {
    base.description = "Could not read the state field from the issue message.";
    return base;
  }
  const index = (issue.line ?? 0) - 1;
  const before = lines[index];
  const span = before === undefined ? undefined : rowsSpan(before);
  if (before === undefined || !span) {
    base.description = `Line ${issue.line ?? "?"} is not a %%section with rows:; left alone.`;
    return base;
  }
  const rows = parseRows(before.slice(span.start, span.end))
    .map((row) => row.filter((name) => name !== column))
    .filter((row) => row.length > 0);
  if (rows.length === 0) {
    lines.splice(index, 1);
    base.applied = true;
    base.description = `Removed the section that placed only "${column}"; the state is shown in the form's header.`;
    base.changes = [{ lineNo: index + 1, before, after: "", action: "delete" }];
    return base;
  }
  return rewriteRows(
    lines,
    issue,
    base,
    () => rows,
    `Removed "${column}" from the section; the state is shown read-only in the form's header.`
  );
}

/**
 * EML512: a rule or saga that moved a record when a person recorded a move's time.
 * An action button makes the move now, so the section goes; the checker only
 * reports one whose every step or action is part of that pattern
 * (language/move-facts.ts). The `<state>_at` help is rewritten in place, so no
 * other fix's line number changes.
 */
function fixRetiredMove(lines: string[], issue: Issue, base: FixResult): FixResult {
  const index = (issue.line ?? 0) - 1;
  const span = sectionSpan(lines, index);
  if (!span) {
    base.description = `Line ${issue.line ?? "?"} is not a move rule or saga; left alone.`;
    return base;
  }
  const name = lines[index]!.trim().split(/\s+/)[1];
  const removed = lines.splice(span.start, span.end - span.start);
  const rewritten = rewriteStockHelp(lines);
  base.applied = true;
  base.description =
    `Removed ${name} (${removed.length} lines); an action button makes this move now.` +
    (rewritten ? ` Rewrote ${rewritten} help line${rewritten === 1 ? "" : "s"} on the <state>_at columns.` : "");
  base.changes = removed.map((before, offset) => ({
    lineNo: span.start + offset + 1,
    before,
    after: "",
    action: "delete" as const,
  }));
  return base;
}

// ---------------------------------------------------------------------------
// Fix: EML001 — Missing %%meta name
// ---------------------------------------------------------------------------

function fixMissingMetaName(lines: string[], _issue: Issue, base: FixResult): FixResult {
  // Derive a name from the first entity or from the file name encoded in the message
  let name = "EML Model";
  // Look for first entity declaration in the ERD
  for (const line of lines) {
    const m = line.trim().match(/^([A-Za-z][A-Za-z0-9_]*)\s*\{$/);
    if (m && m[1] !== "erDiagram") {
      name = `${m[1]} App`;
      break;
    }
  }

  // Find the first non-comment, non-blank line to insert before
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed && !trimmed.startsWith("%%") && !trimmed.startsWith("%")) {
      insertAt = i;
      break;
    }
    // If the line is a %% comment that contains "meta name", it already exists
    if (trimmed.startsWith("%%meta name:")) {
      base.description = "%%meta name already present.";
      return base;
    }
  }

  const newLine = `%%meta name: ${name}`;
  lines.splice(insertAt, 0, newLine);
  base.applied = true;
  base.description = `Inserted  ${newLine}  at line ${insertAt + 1}.`;
  base.changes.push({ lineNo: insertAt + 1, before: "", after: newLine, action: "insert" });
  return base;
}

// ---------------------------------------------------------------------------
// Fix: EML287 — A rule condition naming a column that does not exist
// ---------------------------------------------------------------------------

/**
 * Rewrite a camelCase identifier in a `%%action … when:` condition to the
 * snake_case column it meant.
 *
 * A rule is evaluated against the record being written, whose keys are the
 * ERD's column names — and every column an EML ERD declares is snake_case. So
 * `when: encounterId == null` compares `undefined` to `null`, which is true,
 * and the rule refuses every write to that entity; `when: isCritical == true`
 * compares `undefined` to `true`, which is false, and the rule never fires at
 * all. Neither reports anything: the rule is seeded, listed in the admin
 * screen and drawn by the viewer, and the only symptom is an entity that
 * cannot be created or a rule nobody notices is dead.
 *
 * The rewrite is confined to the `when:` value, and only to identifiers that
 * carry a lower-to-upper transition. A string literal is left alone — the
 * values a condition compares against are the model's own enum values and are
 * not columns — and so is every other key on the line.
 */
function fixCamelCaseRuleCondition(lines: string[], issue: Issue, base: FixResult): FixResult {
  const lineNo = issue.line ? issue.line - 1 : -1;
  if (lineNo < 0 || lineNo >= lines.length) {
    base.description = "EML287 carries no line to repair.";
    return base;
  }

  const original = lines[lineNo] ?? "";
  if (!/^\s*%%action\b/.test(original)) {
    base.description = `Line ${issue.line} is not a %%action directive.`;
    return base;
  }

  // The condition runs from `when:` to the next key on the line. Splitting on
  // the keys rather than on whitespace is what keeps `message:` prose — which
  // routinely contains words with capitals — out of the rewrite.
  const WHEN = /^(.*?\bwhen:\s*)(.*?)(\s+(?:message|field|value|workflow|to|target):\s.*)?$/;
  const match = original.match(WHEN);
  if (!match) {
    base.description = "Could not isolate the when: condition.";
    return base;
  }

  type WhenParts = [string, string, string, string | undefined];
  const [, head, condition, tail] = match as unknown as WhenParts;

  const renamed: string[] = [];
  // Skip quoted literals: a condition compares against the model's own enum
  // values, and `'critical_high'` is not a column to rename.
  const repaired = condition.replace(/'[^']*'|"[^"]*"|\b[a-z][A-Za-z0-9]*\b/g, (token) => {
    if (token.startsWith("'") || token.startsWith('"')) return token;
    if (!/[a-z][A-Z]/.test(token)) return token;
    const snake = token.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    renamed.push(`${token} → ${snake}`);
    return snake;
  });

  if (renamed.length === 0) {
    base.description = "No camelCase identifier found in the condition.";
    return base;
  }

  lines[lineNo] = `${head}${repaired}${tail ?? ""}`;
  base.applied = true;
  base.description = `Rewrote ${renamed.join(", ")} in the rule condition.`;
  base.changes = [
    {
      lineNo: issue.line ?? lineNo + 1,
      before: original,
      after: lines[lineNo] ?? "",
      action: "replace",
    },
  ];
  return base;
}

// ---------------------------------------------------------------------------
// Fix: EML114 — Foreign key does not end in _id
// ---------------------------------------------------------------------------

/**
 * Append the `_id` suffix to an FK column so the generator can resolve what it
 * points at.
 *
 * This matters most for `_by` columns. `reported_by FK` names a person by the
 * role they played, and the generator resolves person-role columns to the user
 * entity — but only once the name ends in `_id`. Without the suffix the column
 * is not treated as a reference at all: it is stored as a plain string, and
 * grids and forms render the raw UUID with no lookup and no display name.
 * `reported_by_id FK` resolves to bus_user and renders the user's name.
 *
 * The rewrite is confined to the attribute name. Type, modifiers, any trailing
 * `"comment"`, and the column alignment of the surrounding block are preserved,
 * so the diff is one identifier wide.
 */
function fixForeignKeyNaming(lines: string[], issue: Issue, base: FixResult): FixResult {
  // 'Foreign key "Entity.column" does not end with "_id".'
  const match = issue.message.match(/Foreign key "([^".]+)\.([^"]+)"/);
  if (!match) {
    base.description = "Could not extract entity and column from issue message.";
    return base;
  }
  const [, entityName, columnName] = match as unknown as [string, string, string];

  if (columnName.endsWith("_id")) {
    base.description = `"${columnName}" already ends with "_id".`;
    return base;
  }

  const lineNo = issue.line ? issue.line - 1 : findAttributeLine(lines, entityName, columnName);
  if (lineNo < 0 || lineNo >= lines.length) {
    base.description = `Could not locate "${entityName}.${columnName}" in the source.`;
    return base;
  }

  const before = lines[lineNo]!;
  // <indent><type><gap><name><rest>. Only the name is replaced, and the gap that
  // follows the type is left alone so aligned attribute blocks stay aligned.
  const attrRe = new RegExp(`^(\\s*[A-Za-z][A-Za-z0-9_()]*\\s+)${escapeRe(columnName)}\\b`);
  if (!attrRe.test(before)) {
    base.description = `Line ${lineNo + 1} does not look like the "${columnName}" attribute; left alone.`;
    return base;
  }

  const after = before.replace(attrRe, `$1${columnName}_id`);
  if (after === before) {
    base.description = `Rewrite of "${columnName}" produced no change.`;
    return base;
  }

  lines[lineNo] = after;
  base.applied = true;
  const target = isPersonRoleColumn(columnName) ? "bus_user" : `bus_${columnName}`;
  base.description = `Renamed "${entityName}.${columnName}" to "${columnName}_id" — now resolves to ${target}.`;
  base.changes.push({ lineNo: lineNo + 1, before, after, action: "replace" });
  return base;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Fallback when the issue carries no line: scan the entity block for the attribute. */
function findAttributeLine(lines: string[], entityName: string, columnName: string): number {
  const openRe = new RegExp(`^\\s*${escapeRe(entityName)}\\s*\\{`);
  let inEntity = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!inEntity) {
      if (openRe.test(line)) inEntity = true;
      continue;
    }
    if (/^\s*\}/.test(line)) return -1;
    if (new RegExp(`\\b${escapeRe(columnName)}\\b`).test(line)) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Fix: EML112 — Duplicate attribute
// ---------------------------------------------------------------------------

/**
 * Delete a column declared twice, keeping the stronger of the two.
 *
 * The duplicate is not merely untidy: both lines reached the generated
 * `CREATE TABLE`, and PostgreSQL refuses a statement that names a column twice,
 * so the application did not open. The parser now collapses them; this makes
 * the same repair to the document, so the file the author keeps says what the
 * generator will actually build.
 *
 * The later line goes and the first one stays — that is where the author was
 * describing the column. But a constraint only the deleted line carried has to
 * move onto the survivor first, or the repair would quietly weaken the model:
 * `string title OPTIONAL` followed by `string title` means the column is
 * required, and dropping the second line without taking `OPTIONAL` off the
 * first turns a mandatory column into a nullable one. Losing data integrity is
 * a worse outcome than the duplicate was.
 */
function fixDuplicateAttribute(lines: string[], issue: Issue, base: FixResult): FixResult {
  const match = issue.message.match(/Duplicate attribute "([^".]+)\.([^"]+)"/);
  if (!match) {
    base.description = "Could not extract entity and column from issue message.";
    return base;
  }
  const [, entityName, columnName] = match as unknown as [string, string, string];

  const duplicateNo = issue.line ? issue.line - 1 : -1;
  const firstMatch = issue.hint?.match(/First occurrence on line (\d+)/);
  const firstNo = firstMatch?.[1] ? Number(firstMatch[1]) - 1 : -1;

  if (duplicateNo < 0 || duplicateNo >= lines.length || firstNo < 0 || firstNo >= lines.length) {
    base.description = `Could not locate both declarations of "${entityName}.${columnName}".`;
    return base;
  }

  const duplicate = lines[duplicateNo]!;
  const first = lines[firstNo]!;
  const nameRe = new RegExp(`^\\s*[A-Za-z][A-Za-z0-9_()]*\\s+${escapeRe(columnName)}\\b`);
  if (!nameRe.test(duplicate) || !nameRe.test(first)) {
    base.description = `Lines ${firstNo + 1} and ${duplicateNo + 1} do not both declare "${columnName}"; left alone.`;
    return base;
  }

  /* Modifiers are upper-case words after the name. The column is required
     unless a declaration says otherwise, so it is mandatory when *either* line
     omits OPTIONAL/NULL — and then the survivor must not carry one. */
  const modifiersOf = (line: string) =>
    line
      .trim()
      .split(/\s+/)
      .slice(2)
      .map((word) => word.toUpperCase());
  const optional = (line: string) =>
    modifiersOf(line).some((word) => word === "OPTIONAL" || word === "NULL");

  let kept = first;
  if (optional(first) && !optional(duplicate)) {
    kept = kept.replace(/\s+(OPTIONAL|NULL)\b/gi, "");
  }
  for (const modifier of ["UK", "UNIQUE", "FK"]) {
    if (modifiersOf(duplicate).includes(modifier) && !modifiersOf(kept).includes(modifier)) {
      kept = `${kept.trimEnd()} ${modifier}`;
    }
  }

  base.changes = [];
  if (kept !== first) {
    lines[firstNo] = kept;
    base.changes.push({ lineNo: firstNo + 1, before: first, after: kept, action: "replace" });
  }
  lines.splice(duplicateNo, 1);
  base.changes.push({ lineNo: duplicateNo + 1, before: duplicate, after: "", action: "delete" });

  base.applied = true;
  base.description =
    kept === first
      ? `Removed the second declaration of "${entityName}.${columnName}".`
      : `Removed the second declaration of "${entityName}.${columnName}", keeping its stronger constraints.`;
  return base;
}

// ---------------------------------------------------------------------------
// Fix: EML103 — A column the generator adds anyway
// ---------------------------------------------------------------------------

/**
 * Delete a declaration of a column the generator manages.
 *
 * `id`, `version`, the audit pair and the soft-delete pair are on every
 * generated table already. A model that declares one produced a duplicate
 * column in the `CREATE TABLE` and the application failed to open. The
 * generator drops it now; removing the line as well means the document and the
 * built schema agree, and the author is not left wondering why the column they
 * wrote does not behave the way they wrote it.
 */
function fixManagedColumn(lines: string[], issue: Issue, base: FixResult): FixResult {
  const match = issue.message.match(/Column "([^".]+)\.([^"]+)" is added by the generator/);
  if (!match) {
    base.description = "Could not extract entity and column from issue message.";
    return base;
  }
  const [, entityName, columnName] = match as unknown as [string, string, string];

  const lineNo = issue.line ? issue.line - 1 : findAttributeLine(lines, entityName, columnName);
  if (lineNo < 0 || lineNo >= lines.length) {
    base.description = `Could not locate "${entityName}.${columnName}" in the source.`;
    return base;
  }

  const nameRe = new RegExp(`^\\s*[A-Za-z][A-Za-z0-9_()]*\\s+${escapeRe(columnName)}\\b`);
  if (!nameRe.test(lines[lineNo]!)) {
    base.description = `Line ${lineNo + 1} does not declare "${columnName}"; left alone.`;
    return base;
  }

  const before = lines[lineNo]!;
  lines.splice(lineNo, 1);
  base.applied = true;
  base.description = `Removed "${entityName}.${columnName}" — the generator adds it.`;
  base.changes = [{ lineNo: lineNo + 1, before, after: "", action: "delete" }];
  return base;
}

// ---------------------------------------------------------------------------
// Fix: EML117 — No primary key
// ---------------------------------------------------------------------------

function fixMissingPrimaryKey(lines: string[], issue: Issue, base: FixResult): FixResult {
  // Extract entity name from the message: 'Entity "Name" has no primary key'
  const entityMatch = issue.message.match(/Entity "([^"]+)"/);
  if (!entityMatch) {
    base.description = "Could not extract entity name from issue message.";
    return base;
  }
  const entityName = entityMatch[1]!;

  // Find the entity's opening brace line
  const openBraceRe = new RegExp(`^\\s*${entityName}\\s*\\{`);
  let openBraceLine = issue.line ? issue.line - 1 : -1; // 0-indexed

  if (openBraceLine < 0) {
    for (let i = 0; i < lines.length; i++) {
      if (openBraceRe.test(lines[i]!)) {
        openBraceLine = i;
        break;
      }
    }
  }

  if (openBraceLine < 0) {
    base.description = `Could not find entity block for "${entityName}".`;
    return base;
  }

  // Insert  string id PK  as the first attribute (line after opening brace)
  const insertAt = openBraceLine + 1;
  const indent = lines[insertAt]?.match(/^(\s*)/)?.[1] ?? "    ";
  const newLine = `${indent}string id PK`;
  lines.splice(insertAt, 0, newLine);
  base.applied = true;
  base.description = `Prepended  string id PK  to entity "${entityName}" at line ${insertAt + 1}.`;
  base.changes.push({ lineNo: insertAt + 1, before: "", after: newLine, action: "insert" });
  return base;
}

// ---------------------------------------------------------------------------
// Fix: EML421 — State workflow: no initial state
// ---------------------------------------------------------------------------

function fixMissingInitialTransition(lines: string[], issue: Issue, base: FixResult): FixResult {
  // Find the stateDiagram-v2 that belongs to the named workflow
  const wfMatch = issue.message.match(/workflow "([^"]+)"/);
  const wfName = wfMatch?.[1];

  // Locate the stateDiagram-v2 section (look for %%workflow <wfName> first, then next stateDiagram-v2)
  let stateDiagramLine = -1;
  let searchFrom = 0;
  if (wfName) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(`%%workflow ${wfName}`)) {
        searchFrom = i;
        break;
      }
    }
  }
  for (let i = searchFrom; i < lines.length; i++) {
    if (/^\s*stateDiagram(-v2)?\s*$/.test(lines[i]!)) {
      stateDiagramLine = i;
      break;
    }
  }

  if (stateDiagramLine < 0) {
    base.description = `Could not find stateDiagram section for workflow "${wfName ?? "unknown"}".`;
    return base;
  }

  // Find first non-blank, non-comment line inside the diagram → that is the first state
  let firstState: string | undefined;
  for (let i = stateDiagramLine + 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t || t.startsWith("%%")) continue;
    if (/^\[\*\]/.test(t)) {
      // already has initial
      base.description = "Initial transition [*] --> already present.";
      return base;
    }
    // Extract left-hand side state
    const m = t.match(/^(\w+)\s*-->/);
    if (m) {
      firstState = m[1];
      break;
    }
    const m2 = t.match(/^(\w+)\s*$/);
    if (m2) {
      firstState = m2[1];
      break;
    }
  }

  if (!firstState) {
    base.description = "Could not determine first state.";
    return base;
  }

  const insertAt = stateDiagramLine + 1;
  const indent = lines[insertAt]?.match(/^(\s*)/)?.[1] ?? "    ";
  const newLine = `${indent}[*] --> ${firstState}`;
  lines.splice(insertAt, 0, newLine);
  base.applied = true;
  base.description = `Inserted  [*] --> ${firstState}  at line ${insertAt + 1}.`;
  base.changes.push({ lineNo: insertAt + 1, before: "", after: newLine, action: "insert" });
  return base;
}

// ---------------------------------------------------------------------------
// Fix: EML422 — State workflow: no terminal state
// ---------------------------------------------------------------------------

function fixMissingTerminalTransition(lines: string[], issue: Issue, base: FixResult): FixResult {
  const wfMatch = issue.message.match(/workflow "([^"]+)"/);
  const wfName = wfMatch?.[1];

  let stateDiagramLine = -1;
  let searchFrom = 0;
  if (wfName) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(`%%workflow ${wfName}`)) {
        searchFrom = i;
        break;
      }
    }
  }
  for (let i = searchFrom; i < lines.length; i++) {
    if (/^\s*stateDiagram(-v2)?\s*$/.test(lines[i]!)) {
      stateDiagramLine = i;
      break;
    }
  }

  if (stateDiagramLine < 0) {
    base.description = `Could not find stateDiagram section.`;
    return base;
  }

  // Find the end of the diagram (next blank line or next section opener)
  let diagramEnd = stateDiagramLine + 1;
  let lastState: string | undefined;
  const seenTargets = new Set<string>();
  const seenSources = new Set<string>();

  for (let i = stateDiagramLine + 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t || t.startsWith("%%")) {
      if (!t) {
        diagramEnd = i;
        break;
      }
      continue;
    }
    if (/^(erDiagram|flowchart|graph|stateDiagram)/.test(t)) {
      diagramEnd = i;
      break;
    }
    // Parse transition
    const m = t.match(/^(\[\*\]|\w+)\s*-->\s*(\[\*\]|\w+)/);
    if (m) {
      if (m[1] !== "[*]") seenSources.add(m[1]!);
      if (m[2] !== "[*]") seenTargets.add(m[2]!);
      if (m[2] === "[*]") {
        base.description = "Terminal transition already present.";
        return base;
      }
      lastState = m[1]!;
      diagramEnd = i + 1;
    }
  }

  // Candidate terminal states: states that appear as sources but never as targets (leaves)
  const candidates = [...seenSources].filter((s) => !seenTargets.has(s));
  const terminal = candidates[0] ?? lastState;

  if (!terminal) {
    base.description = "Could not determine terminal state.";
    return base;
  }

  const indent = lines[stateDiagramLine + 1]?.match(/^(\s*)/)?.[1] ?? "    ";
  const newLine = `${indent}${terminal} --> [*]`;
  lines.splice(diagramEnd, 0, newLine);
  base.applied = true;
  base.description = `Inserted  ${terminal} --> [*]  at line ${diagramEnd + 1}.`;
  base.changes.push({ lineNo: diagramEnd + 1, before: "", after: newLine, action: "insert" });
  return base;
}

// ---------------------------------------------------------------------------
// Process a single .mmd.error file
// ---------------------------------------------------------------------------

interface FixSummary {
  errorFile: string;
  mmdFile: string;
  applied: number;
  skipped: number;
  unfixable: number;
  results: FixResult[];
}

function processErrorFile(errorFilePath: string, dryRun: boolean): FixSummary {
  // Load the error file
  let errorData: ErrorFile;
  try {
    errorData = JSON.parse(readFileSync(errorFilePath, "utf8")) as ErrorFile;
  } catch (e) {
    throw new Error(
      `Cannot parse error file "${errorFilePath}": ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const mmdFile = errorData.file;
  if (!existsSync(mmdFile)) {
    throw new Error(`Source .mmd file not found: ${mmdFile}`);
  }

  const fixableIssues = errorData.issues.filter((i) => i.autoFixable);
  const unfixable = errorData.issues.filter(
    (i) => !i.autoFixable && (i.severity === "error" || i.severity === "warning")
  ).length;

  if (fixableIssues.length === 0) {
    return {
      errorFile: errorFilePath,
      mmdFile,
      applied: 0,
      skipped: 0,
      unfixable,
      results: [],
    };
  }

  const source = readFileSync(mmdFile, "utf8");
  const { newSource, results } = applyFixes(source, errorData.issues);

  if (!dryRun && newSource !== source) {
    writeFileSync(mmdFile, newSource, "utf8");
  }

  const applied = results.filter((r) => r.applied).length;
  const skipped = results.filter((r) => !r.applied).length;

  return { errorFile: errorFilePath, mmdFile, applied, skipped, unfixable, results };
}

// ---------------------------------------------------------------------------
// Re-run checker on a fixed file
// ---------------------------------------------------------------------------

async function recheck(mmdFile: string): Promise<{ exitCode: number; output: string }> {
  // Find checker.ts relative to this fixer file
  const checkerPath = path.join(path.dirname(new URL(import.meta.url).pathname), "checker.ts");
  if (!existsSync(checkerPath)) {
    return { exitCode: 1, output: `checker.ts not found at ${checkerPath}` };
  }

  // Imported here rather than at module scope: this is the only line in the file
  // that needs a subprocess, and the WASM generator imports this module into a
  // browser bundle where node:child_process cannot resolve.
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("bun", [checkerPath, mmdFile], {
    encoding: "utf8",
    timeout: 30_000,
  });

  return {
    exitCode: result.status ?? 1,
    output: (result.stdout ?? "") + (result.stderr ?? ""),
  };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`${c.bold("eml-fix")} — EML auto-fixer

${c.bold("USAGE")}
  bun language/fixer.ts <file.mmd.error>
  bun language/fixer.ts <file.mmd>          # derives the .error file name
  bun language/fixer.ts <directory/>        # fix all .mmd.error files in dir

${c.bold("OPTIONS")}
  --dry-run      Show what would be fixed without writing files
  --no-recheck   Do not re-run checker.ts after applying fixes
  --json         Machine-readable output
  -h, --help     Show this help

${c.bold("AUTO-FIXABLE CODES")}
  EML001   Missing %%meta name → insert %%meta name: <derived>
  EML114   FK not ending in _id → append the suffix, e.g. reported_by → reported_by_id
           (_by columns then resolve to the user entity rather than degrading to
            a plain string that renders as a raw UUID)
  EML112   Duplicate attribute → delete the later line, keeping the stronger constraints
  EML103   A column the generator adds anyway → delete the line
  EML287   camelCase in a %%action when: → rewrite it as the snake_case column
  EML172   columns no %%section row places → append them to the last section
  EML174   a %%section row of three or more → split it into rows of two
  EML175   a column placed in two %%section rows → remove the later one
  EML178   the state field placed in a %%section row → remove it from the row
  EML512   a move rule or saga a button replaces → remove it
  EML117   No primary key → insert  string id PK  as first attribute
  EML421   State workflow: no [*]→First transition → insert it
  EML422   State workflow: no terminal state (→[*]) → insert it

${c.bold("WORKFLOW")}
  1. Run:  bun language/checker.ts your-model.mmd
  2. Fix:  bun language/fixer.ts your-model.mmd.error
  3. Checker re-runs automatically — check the updated output.
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const flags = {
    dryRun: hasFlag("--dry-run"),
    noRecheck: hasFlag("--no-recheck"),
    json: hasFlag("--json"),
    help: hasFlag("--help") || hasFlag("-h"),
  };

  if (flags.help || process.argv.length < 3) {
    printHelp();
    process.exit(0);
  }

  const rawArg = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (!rawArg) {
    console.error(c.red("Error: No input specified."));
    printHelp();
    process.exit(2);
  }

  if (!existsSync(rawArg)) {
    console.error(c.red(`File or directory not found: ${rawArg}`));
    process.exit(2);
  }

  // Resolve to .mmd.error file(s)
  let errorFiles: string[] = [];
  const st = statSync(rawArg);
  if (st.isDirectory()) {
    const entries = readdirSync(rawArg, { withFileTypes: true });
    errorFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".mmd.error"))
      .map((e) => path.join(rawArg, e.name));
    if (errorFiles.length === 0) {
      console.log(c.yellow(`No .mmd.error files found in: ${rawArg}`));
      process.exit(0);
    }
  } else if (rawArg.endsWith(".mmd.error")) {
    errorFiles = [rawArg];
  } else if (rawArg.endsWith(".mmd")) {
    // Derive the error file name
    const errorFilePath = `${rawArg}.error`;
    if (!existsSync(errorFilePath)) {
      console.log(c.yellow(`No error file found for ${rawArg}. Run checker first:`));
      console.log(c.dim(`  bun language/checker.ts ${rawArg}`));
      process.exit(0);
    }
    errorFiles = [errorFilePath];
  } else {
    console.error(c.red(`Input must be a .mmd, .mmd.error file, or a directory.`));
    process.exit(2);
  }

  const allSummaries: FixSummary[] = [];

  for (const errorFile of errorFiles) {
    let summary: FixSummary;
    try {
      summary = processErrorFile(errorFile, flags.dryRun);
    } catch (err) {
      console.error(
        c.red(`Error processing ${errorFile}: ${err instanceof Error ? err.message : String(err)}`)
      );
      continue;
    }
    allSummaries.push(summary);

    if (flags.json) continue; // collect all, output at end

    const relMmd = path.relative(process.cwd(), summary.mmdFile);
    const relErr = path.relative(process.cwd(), summary.errorFile);
    console.log(`\n${c.bold(flags.dryRun ? "Dry run:" : "Fixing:")} ${c.cyan(relMmd)}`);
    console.log(c.dim(`  error file: ${relErr}`));

    if (summary.results.length === 0) {
      if (summary.unfixable > 0) {
        console.log(
          c.yellow(
            `  No auto-fixable issues. ${summary.unfixable} issue(s) require manual intervention.`
          )
        );
      } else {
        console.log(c.green("  No auto-fixable issues found — file is already clean."));
      }
    } else {
      for (const r of summary.results) {
        const icon = r.applied ? c.green("✓") : c.yellow("○");
        const label = r.applied
          ? flags.dryRun
            ? c.cyan("would fix")
            : c.green("fixed")
          : c.dim("skipped");
        console.log(`  ${icon} ${c.dim(`[${r.code}]`)} ${label}  ${r.description}`);
        if (r.applied) {
          for (const ch of r.changes) {
            const lineRef = c.dim(`:${ch.lineNo}`);
            if (ch.action === "insert") {
              console.log(`       ${c.green("+")} ${lineRef}  ${ch.after}`);
            } else if (ch.action === "replace") {
              console.log(`       ${c.red("-")} ${lineRef}  ${ch.before}`);
              console.log(`       ${c.green("+")} ${lineRef}  ${ch.after}`);
            } else {
              console.log(`       ${c.red("-")} ${lineRef}  ${ch.before}`);
            }
          }
        }
      }

      const appliedCount = summary.results.filter((r) => r.applied).length;
      if (!flags.dryRun) {
        console.log(
          `\n  ${c.green(`Applied ${appliedCount} fix(es).`)}` +
            (summary.unfixable > 0
              ? c.yellow(` ${summary.unfixable} issue(s) still need manual attention.`)
              : "")
        );
      } else {
        console.log(
          `\n  ${c.cyan(`Would apply ${appliedCount} fix(es).`)} Run without --dry-run to write changes.`
        );
      }
    }

    // Re-run checker automatically (unless dry-run or disabled)
    if (!flags.dryRun && !flags.noRecheck && summary.applied > 0) {
      console.log(`\n${c.dim("─".repeat(56))}`);
      console.log(`${c.bold("Re-checking")} ${c.cyan(relMmd)}\n`);
      const recheck_result = await recheck(summary.mmdFile);
      // Print checker output indented
      const lines = recheck_result.output.split("\n");
      for (const line of lines) {
        if (line.trim()) console.log(`  ${line}`);
      }
    } else if (!flags.dryRun && summary.unfixable > 0 && summary.applied === 0) {
      console.log(
        c.dim(`\n  Tip: run  bun language/checker.ts ${relMmd}  to see full diagnostics.`)
      );
    }
  }

  if (flags.json) {
    console.log(
      JSON.stringify(allSummaries.length === 1 ? allSummaries[0] : allSummaries, null, 2)
    );
  }

  const anyApplied = allSummaries.some((s) => s.applied > 0);
  process.exit(
    anyApplied || allSummaries.every((s) => s.applied === 0 && s.unfixable === 0) ? 0 : 0
  );
}

// As in checker.ts: importing this file must not start a command.
if (import.meta.main) {
  main().catch((err) => {
    console.error(c.red(`Fatal: ${err instanceof Error ? err.message : String(err)}`));
    if (process.env.EML_DEBUG) console.error(err);
    process.exit(2);
  });
}
