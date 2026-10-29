/**
 * The EML checker, as one file a web page can load.
 *
 * `language/checker.ts` is a Bun command: it reads a `.mmd` off disk, writes a
 * `.mmd.error` beside it and prints in colour. None of that is the checking.
 * The checking is `checkSource` — a string in, a list of diagnostics out — and
 * it has been exported for exactly this reason since the WASM generator needed
 * to refuse a broken model before compiling it.
 *
 * So this file adds no rules. It injects the language definition (a tab has no
 * `appwithai-language.json` to open, so the bundler inlines the same JSON the
 * CLI reads) and re-exports the pure half under names a caller who has never
 * seen this repository can guess. A model checked at appwithai.org/checker.js
 * gets the same diagnostics `bun language/checker.ts` prints, because it is the
 * same engine — the alternative, a second weaker checker written for the web,
 * is how a document comes to pass in one place and fail in the other.
 */

import languageDefinition from "../appwithai-language.json";
import {
  AUTO_FIXABLE_CODES,
  type CheckResult,
  checkSource,
  type Issue,
  type Severity,
} from "../checker";
import { type LanguageDefinition, setLanguageDefinition } from "../index";

setLanguageDefinition(languageDefinition as unknown as LanguageDefinition);

export type { CheckResult, Issue, Severity };

/** The EML version these diagnostics are written against. */
export const LANGUAGE_VERSION: string = languageDefinition.language.version;

/** The five codes `fixer.js` can repair without being told what to do. */
export const AUTO_FIXABLE: string[] = [...AUTO_FIXABLE_CODES].sort();

/** One diagnostic, with the flag the fixer reads and the line it is about. */
export interface CheckedIssue extends Issue {
  autoFixable: boolean;
  /**
   * The source line `line` points at, verbatim.
   *
   * A diagnostic that names a line number and nothing else makes the reader go
   * and count lines, and a reader who miscounts edits the wrong one — which is
   * the common failure when the reader is a language model holding the document
   * in a context window rather than open in an editor. Carrying the text means
   * the correction can be matched against what is actually there.
   *
   * Absent when the diagnostic is about the document as a whole, or when `line`
   * falls outside the source it was checked against.
   */
  lineText?: string;
}

/** What a check run reports. */
export interface CheckReport {
  /** No errors. Warnings and infos may remain — read `counts`. */
  ok: boolean;
  counts: { errors: number; warnings: number; infos: number };
  /** Worst first, then by line, so the first entry is the one to fix. */
  issues: CheckedIssue[];
  languageVersion: string;
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

/**
 * Check an EML document.
 *
 * Sorted worst-first rather than in the order the engine happened to find them:
 * a caller repairing one issue at a time should be reading the error that stops
 * generation, not an info about a naming convention that happens to sit on an
 * earlier line.
 */
export function check(source: string): CheckReport {
  const result: CheckResult = checkSource(source);
  const lines = source.split("\n");
  return {
    ok: result.errors === 0,
    counts: { errors: result.errors, warnings: result.warnings, infos: result.infos },
    issues: [...result.issues]
      .sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.line ?? 0) - (b.line ?? 0)
      )
      .map((issue) => decorate(issue, lines)),
    languageVersion: LANGUAGE_VERSION,
  };
}

/**
 * Add what a caller needs in order to act on a diagnostic: whether the fixer can
 * repair it, and the line it is talking about.
 *
 * `lines` is the source **the issue was produced from**. Handing it the original
 * after a repair has shifted the line numbering is the one way to make this
 * actively misleading, which is why `checkAndFix` re-derives it from the
 * repaired document rather than from its input.
 */
function decorate(issue: Issue, lines: string[]): CheckedIssue {
  const text = issue.line && issue.line >= 1 ? lines[issue.line - 1] : undefined;
  return {
    ...issue,
    autoFixable: AUTO_FIXABLE_CODES.has(issue.code),
    ...(text === undefined ? {} : { lineText: text.replace(/\s+$/, "") }),
  };
}

/** One line per diagnostic, in the shape a log or a terminal wants. */
export function formatIssue(issue: Issue): string {
  const where = issue.line ? `:${issue.line}` : "";
  const hint = issue.hint ? `  — ${issue.hint}` : "";
  return `${issue.severity}${where} [${issue.code}] ${issue.message}${hint}`;
}

/**
 * One diagnostic as a block: what is wrong, the line it is wrong on, and the fix.
 *
 * The one-line form above answers *what* and leaves *where* as a number the
 * reader has to go and resolve. That is fine in a terminal beside an open
 * editor and wrong for the reader this engine mostly has — a language model
 * holding the document in a context window, which counts lines by eye, lands on
 * the wrong one, and edits a line that was never at fault. Showing the text
 * removes the counting: the correction can be matched against the bytes.
 *
 * A diagnostic with no line says so rather than rendering a blank gutter. There
 * are real ones — a missing `%%meta name:` is about the document, not a line —
 * and an empty excerpt reads like a lookup that failed.
 */
export function formatIssueDetail(issue: CheckedIssue): string {
  const gutter = issue.line ? String(issue.line) : "";
  const pad = " ".repeat(gutter.length);
  const head = `${issue.severity}${issue.line ? `:${issue.line}` : ""} [${issue.code}]${
    issue.autoFixable ? " (auto-fixable)" : ""
  } ${issue.message}`;

  const body: string[] = [];
  if (issue.lineText !== undefined) body.push(`  ${gutter} │ ${issue.lineText}`);
  else if (!issue.line)
    body.push(`  ${pad} │ (no single line — this is about the document as a whole)`);
  else body.push(`  ${gutter} │ (line ${issue.line} is not in the source that was checked)`);

  if (issue.context) body.push(`  ${pad} │ ${issue.context}`);
  if (issue.hint) body.push(`  ${pad} └ fix: ${issue.hint}`);
  return [head, ...body].join("\n");
}

/**
 * What to do with the report, worked out from the report itself.
 *
 * Every document that describes the correction loop describes it in the
 * abstract, and a reader who has just been handed nine diagnostics has to map
 * the abstraction onto them. These steps name the actual counts, the actual
 * first line to go to, and the actual auto-fixable codes in front of the reader,
 * because the observed failure is not ignorance of the loop — it is fixing the
 * first diagnostic, re-reading the same stale report, and reporting a verdict
 * that describes a document that no longer exists.
 */
export function formatNextSteps(report: CheckReport): string {
  const { errors, warnings } = report.counts;
  const fixable = report.issues.filter((issue) => issue.autoFixable);
  const manual = report.issues.filter((issue) => !issue.autoFixable);
  const first = manual.find((issue) => issue.severity === "error") ?? manual[0];
  const steps: string[] = [];

  if (fixable.length > 0) {
    const codes = [...new Set(fixable.map((issue) => issue.code))].sort().join(", ");
    steps.push(
      `Run the fixer first — ${fixable.length} of these repair themselves (${codes}). ` +
        `\`checkAndFix(source)\`, or \`node check-model.mjs <file> --write\`. Do not hand-edit them: ` +
        `the repair shifts line numbers, and every number below is from before it.`
    );
  }
  if (manual.length > 0) {
    const where = first?.line ? ` Start at line ${first.line} [${first.code}].` : "";
    steps.push(
      `Fix the remaining ${manual.length} by hand, in the model file — not in this report.` + where
    );
    steps.push(
      `Match each one on the line shown above it rather than on its number. If the text ` +
        `there is not what you expect, the file you are editing is not the file that was checked.`
    );
  }
  steps.push(
    `Re-run the checker over the whole file from zero after every round. A repair can ` +
      `uncover a problem an earlier error was masking, so a report from before your edit ` +
      `describes a document that no longer exists.`
  );
  steps.push(
    errors > 0
      ? `Repeat until the last line reads OK. The generator refuses this model while any error stands.`
      : `The generator accepts this model now. Clearing the ${warnings} warning${
          warnings === 1 ? "" : "s"
        } is optional, but each one names something it accepts and quietly gets wrong.`
  );

  return ["next steps", ...steps.map((step, index) => `  ${index + 1}. ${wrap(step)}`)].join("\n");
}

/** Wrap a step to a readable measure, indented under its own number. */
function wrap(text: string, width = 74): string {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && (line + " " + word).length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.join("\n     ");
}

/**
 * The whole report as text, for pasting back to whoever wrote the model.
 *
 * The verdict goes **last**, after the diagnostics, the way a compiler or a
 * test runner reports: whoever reads this in a terminal reads the bottom of it,
 * and with the verdict on top the final line of a passing run was whichever
 * diagnostic happened to sort last. An `info` rendered that way — same shape as
 * an error, no verdict after it — reads as the reason the run failed, which is
 * the opposite of what it says.
 *
 * The counts name infos too. They were omitted, so a report could say
 * "0 errors, 0 warnings" and then print two notes underneath it, which invited
 * exactly the same misreading from the other end.
 *
 * Each diagnostic is a block rather than a line, and the steps for acting on
 * them follow — see `formatIssueDetail` and `formatNextSteps` for why.
 */
export function formatReport(report: CheckReport): string {
  const { errors, warnings, infos } = report.counts;
  /* Plural properly rather than with "(s)": this line is the one sentence most
     readers of a report actually read, and `1 error(s)` reads like a machine
     apologising for not knowing its own arithmetic. */
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const counted = [
    count(errors, "error"),
    count(warnings, "warning"),
    ...(infos > 0 ? [count(infos, "note")] : []),
  ].join(", ");

  /* A passing run that still printed something says so on the same line, so the
     notes above it cannot be mistaken for the outcome. */
  const advisory =
    report.ok && report.issues.length > 0
      ? " — notes and warnings are advisory; the generator accepts this model"
      : "";
  const verdict = report.ok
    ? `OK — ${counted} (EML ${report.languageVersion})${advisory}`
    : `FAILED — ${counted} (EML ${report.languageVersion})`;

  if (report.issues.length === 0) return verdict;
  /* Diagnostics, then what to do about them, then the verdict — and the verdict
     stays last. That ordering was arrived at once already and for a real
     reason: whoever reads a report reads its final line, so a run whose last
     line is anything but the outcome gets misread as that line. Putting the
     steps after the verdict would have reintroduced exactly the bug that moving
     the verdict to the bottom fixed. */
  return [
    ...report.issues.map((issue) => `${formatIssueDetail(issue)}\n`),
    formatNextSteps(report),
    "",
    verdict,
  ].join("\n");
}

export { checkSource };

// Also reachable without a bound import, so a page that loaded this with a
// bare `import "./checker.js"` can still call it.
(globalThis as Record<string, unknown>).EMLChecker = {
  check,
  checkSource,
  formatIssue,
  formatIssueDetail,
  formatNextSteps,
  formatReport,
  AUTO_FIXABLE,
  LANGUAGE_VERSION,
};
