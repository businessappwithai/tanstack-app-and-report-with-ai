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
  const dictionary = report.issues.filter((issue) => DICTIONARY_COMPLETENESS.has(issue.code));
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
  /*
   * The dictionary warnings are not optional, and this step used to say they
   * were.
   *
   * The closing step read "clearing the N warnings is optional" for every
   * warning alike. But the authoring protocol requires a complete Application
   * Dictionary — help on every entity and every column, the FK modifier on
   * every reference, an enum binding on every closed vocabulary, a `name:` on
   * every category — and `audit-model.mjs` fails a model that is missing any of
   * it. So a model could clear the checker, be told in the checker's own last
   * words that the rest was optional, and then fail the audit the same protocol
   * requires it to pass. The reader here is usually a language model, and the
   * report is the last thing it reads: a blanket "optional" is the sentence it
   * acts on.
   *
   * These nine are the ones that silently degrade what the generated application
   * shows — a lookup that renders a raw uuid, a dropdown that becomes a free
   * text box, a form and a manual that explain nothing, a grouping the parser
   * drops, a form with no sections. None of them stops the generator, which is exactly why none of them
   * announces itself anywhere else.
   */
  if (errors > 0) {
    steps.push(
      `Repeat until the last line reads OK. The generator refuses this model while any error stands.`
    );
  } else if (dictionary.length > 0) {
    const codes = [...new Set(dictionary.map((issue) => issue.code))].sort().join(", ");
    const other = warnings - dictionary.filter((issue) => issue.severity === "warning").length;
    steps.push(
      `The generator accepts this model, and it is not finished. ${dictionary.length} of these ` +
        `(${codes}) are Application Dictionary gaps: the dictionary is what the application ` +
        `draws every screen from, and each one leaves it recording less than the model knows — ` +
        `a reference as text rather than a lookup, a closed vocabulary as a free text box, a ` +
        `field and its manual entry with nothing under it, a form with no sections. Clear them. \`node audit-model.mjs ` +
        `<file>.mmd\` fails while any stand, and the authoring protocol requires it to exit 0.` +
        (other > 0
          ? ` The remaining ${other} warning${other === 1 ? " is" : "s are"} advisory.`
          : "")
    );
  } else {
    steps.push(
      `The generator accepts this model now. Clearing the ${warnings} warning${
        warnings === 1 ? "" : "s"
      } is optional, but each one names something it accepts and quietly gets wrong.`
    );
  }

  return ["next steps", ...steps.map((step, index) => `  ${index + 1}. ${wrap(step)}`)].join("\n");
}

/**
 * The warnings that leave the Application Dictionary saying less than the model
 * does — and which the authoring protocol's checklist and `audit-model.mjs`
 * both treat as mandatory rather than advisory.
 *
 * | code | what the dictionary records instead |
 * |---|---|
 * | `EML119` | a reference column as `String` — a uuid in a text box, not a lookup |
 * | `EML146` | a closed vocabulary as `String` — free text, not a dropdown |
 * | `EML151` | help that restates its own name — coverage without meaning |
 * | `EML152` | `sys_table.description` empty — the entity's manual section opens with nothing |
 * | `EML153` | `sys_column.description` empty — the field prints a dash in the form and the manual |
 * | `EML154` | a `%%category` the parser drops, so its entities fall into "General" |
 * | `EML170` | no `sys_field_group` at all — the form is one flat, unheaded list |
 * | `EML172` | a column no `%%section` row places — it lands in a trailing "Other" section |
 * | `EML177` | `sys_field_group.description` empty — a section heading with nothing under it |
 */
const DICTIONARY_COMPLETENESS = new Set([
  "EML119",
  "EML146",
  "EML151",
  "EML152",
  "EML153",
  "EML154",
  "EML170",
  "EML172",
  "EML177",
]);

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

  /*
   * A passing run that still printed something says so on the same line, so the
   * notes above it cannot be mistaken for the outcome.
   *
   * "Advisory" is true of most warnings and false of the dictionary ones, and
   * this is the line §8.2 tells a reader to read — so saying it flatly here
   * undid what `formatNextSteps` had just said two lines above. A model that
   * clears the checker and skips these fails `audit-model.mjs`, which the
   * authoring protocol requires to exit 0, so the verdict names them rather
   * than waving at them.
   */
  const dictionaryGaps = report.issues.filter((issue) =>
    DICTIONARY_COMPLETENESS.has(issue.code)
  ).length;
  const advisory = !report.ok
    ? ""
    : dictionaryGaps > 0
      ? ` — the generator accepts this model, but ${dictionaryGaps} Application Dictionary gap${
          dictionaryGaps === 1 ? "" : "s"
        } above must still be cleared (audit-model.mjs fails while they stand)`
      : report.issues.length > 0
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
