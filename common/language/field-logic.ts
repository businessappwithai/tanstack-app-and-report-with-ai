/**
 * Field logic — Compiere's Display Logic, Read Only Logic and Mandatory Logic.
 *
 * Three conditions a field carries in the Application Dictionary, each a
 * boolean expression over the values of the record being edited:
 *
 *   %%field Opportunity.loss_reason display: @stage@=closed_lost
 *   %%field Opportunity.amount readonly: @stage@=closed_won | @stage@=closed_lost
 *   %%field Contract.renewal_notice_days mandatory: @auto_renew@=Y
 *
 * The syntax is Compiere's own (org.compiere.util.Evaluator), so an expression
 * copied out of an iDempiere dictionary means the same thing here:
 *
 * - a condition is `<operand> <operator> <operand>`, where an operand is a
 *   variable `@column@`, a quoted literal `'x'` / `"x"`, or a bare word;
 * - operators: `=`, `!` (not equal; `!=`, `^` and `<>` are accepted too),
 *   `>`, `<`, `>=`, `<=`;
 * - conditions join with `&` (and) and `|` (or), evaluated strictly left to
 *   right with no precedence and no parentheses — `a | b & c` is `(a | b) & c`,
 *   as it is in Compiere.
 *
 * Values are compared the way Compiere's context holds them: a boolean is `Y`
 * or `N`, an empty value is the empty string (`@x@=''` and `@x@!''` test for
 * it), and two operands that both read as numbers compare as numbers.
 *
 * This file is the one reading of that syntax. The checker validates with it,
 * and the generated applications evaluate with a byte-identical copy
 * (`packages/generator/templates/common/field-logic.ts`, held by a test) — so a
 * condition the checker accepts is one both the form and the API read the same
 * way. It has no imports for that reason.
 */

export type LogicOperator = "=" | "!" | ">" | "<" | ">=" | "<=";
export type LogicJoin = "&" | "|";

export type LogicOperand = { kind: "variable"; name: string } | { kind: "literal"; value: string };

export interface LogicCondition {
  left: LogicOperand;
  operator: LogicOperator;
  right: LogicOperand;
}

export interface ParsedLogic {
  conditions: LogicCondition[];
  /** `joins[i]` joins `conditions[i]` to `conditions[i + 1]`. */
  joins: LogicJoin[];
  /** Every `@name@` the expression reads, in order, without repeats. */
  variables: string[];
}

/*
 * Both members name both keys, so `result.error` reads without narrowing on
 * `ok` — the generated backend compiles without `strictNullChecks`, where a
 * discriminated union does not narrow.
 */
export type LogicParseResult =
  | { ok: true; logic: ParsedLogic; error?: undefined }
  | { ok: false; logic?: undefined; error: string };

/** The three kinds, as the dictionary columns name them. */
export type LogicKind = "display" | "readonly" | "mandatory";

const OPERATOR_ALIASES: Record<string, LogicOperator> = {
  "=": "=",
  "==": "=",
  "!": "!",
  "!=": "!",
  "^": "!",
  "<>": "!",
  ">": ">",
  "<": "<",
  ">=": ">=",
  "<=": "<=",
};

/** Longest first, so `>=` is not read as `>` followed by `=`. */
const OPERATOR_TOKENS = ["!=", "<>", ">=", "<=", "==", "=", "!", "^", ">", "<"];

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Split on `&` and `|` outside quotes and outside `@…@`, keeping the joins.
 */
function splitConditions(source: string): { parts: string[]; joins: LogicJoin[] } | string {
  const parts: string[] = [];
  const joins: LogicJoin[] = [];
  let current = "";
  let quote: string | null = null;
  let inVariable = false;
  for (const ch of source) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "@") inVariable = !inVariable;
    if (!inVariable && (ch === "&" || ch === "|")) {
      parts.push(current);
      joins.push(ch);
      current = "";
      continue;
    }
    if (!inVariable && (ch === "(" || ch === ")")) {
      return "Parentheses are not supported: conditions are evaluated left to right.";
    }
    current += ch;
  }
  if (quote) return "A quoted value is not closed.";
  if (inVariable) return "A variable is not closed: write it as @column@.";
  parts.push(current);
  return { parts, joins };
}

function parseOperand(raw: string): LogicOperand | string {
  const text = raw.trim();
  if (text === "") return { kind: "literal", value: "" };
  if (text.startsWith("@")) {
    if (!text.endsWith("@") || text.length < 3) return `"${text}" is not a variable: write @column@.`;
    const name = text.slice(1, -1).trim();
    if (!VARIABLE_NAME.test(name)) return `"${text}" is not a column name.`;
    return { kind: "variable", name };
  }
  const first = text[0];
  if (first === "'" || first === '"') {
    if (text.length < 2 || text[text.length - 1] !== first) return `${text} is not closed.`;
    return { kind: "literal", value: text.slice(1, -1) };
  }
  if (text.includes("@")) return `"${text}" mixes a variable into a value.`;
  return { kind: "literal", value: text };
}

/** Find the operator outside the variable and outside quotes. */
function splitComparison(text: string): [string, string, string] | null {
  let quote: string | null = null;
  let inVariable = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "@") {
      inVariable = !inVariable;
      continue;
    }
    if (inVariable) continue;
    for (const token of OPERATOR_TOKENS) {
      if (text.startsWith(token, i)) {
        return [text.slice(0, i), token, text.slice(i + token.length)];
      }
    }
  }
  return null;
}

export function parseLogic(source: string): LogicParseResult {
  const text = (source ?? "").trim();
  if (!text) return { ok: false, error: "The expression is empty." };
  const split = splitConditions(text);
  if (typeof split === "string") return { ok: false, error: split };
  const conditions: LogicCondition[] = [];
  const variables: string[] = [];
  for (const part of split.parts) {
    const trimmed = part.trim();
    if (!trimmed) return { ok: false, error: "A condition is missing beside & or |." };
    const comparison = splitComparison(trimmed);
    if (!comparison) {
      return {
        ok: false,
        error: `"${trimmed}" has no comparison: write @column@=value, @column@!value, > or <.`,
      };
    }
    const [leftRaw, token, rightRaw] = comparison;
    const left = parseOperand(leftRaw);
    if (typeof left === "string") return { ok: false, error: left };
    const right = parseOperand(rightRaw);
    if (typeof right === "string") return { ok: false, error: right };
    if (left.kind !== "variable" && right.kind !== "variable") {
      return { ok: false, error: `"${trimmed}" compares two constants: one side must be @column@.` };
    }
    for (const operand of [left, right]) {
      if (operand.kind === "variable" && !variables.includes(operand.name)) {
        variables.push(operand.name);
      }
    }
    conditions.push({ left, operator: OPERATOR_ALIASES[token] as LogicOperator, right });
  }
  return { ok: true, logic: { conditions, joins: split.joins, variables } };
}

/**
 * A record value as Compiere's context holds it: booleans `Y`/`N`, nothing as
 * the empty string, a date as its ISO text.
 */
export function contextValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value === true) return "Y";
  if (value === false) return "N";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function asNumber(text: string): number | null {
  if (text.trim() === "") return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function compare(left: string, operator: LogicOperator, right: string): boolean {
  const l = asNumber(left);
  const r = asNumber(right);
  const numeric = l !== null && r !== null;
  switch (operator) {
    case "=":
      return numeric ? l === r : left === right;
    case "!":
      return numeric ? l !== r : left !== right;
    case ">":
      return numeric ? (l as number) > (r as number) : left > right;
    case "<":
      return numeric ? (l as number) < (r as number) : left < right;
    case ">=":
      return numeric ? (l as number) >= (r as number) : left >= right;
    case "<=":
      return numeric ? (l as number) <= (r as number) : left <= right;
  }
}

function resolve(operand: LogicOperand, record: Record<string, unknown>): string {
  return operand.kind === "variable" ? contextValue(record[operand.name]) : operand.value;
}

/**
 * Evaluate an expression against a record. An empty expression is `fallback`
 * (no logic means the static flag stands); an expression that does not parse
 * is `false` — the checker refuses one, so reaching here means a dictionary
 * edited by hand, and a broken condition must not hide a field or lock it.
 */
export function evaluateLogic(
  source: string | null | undefined,
  record: Record<string, unknown>,
  fallback = false
): boolean {
  if (!source || !source.trim()) return fallback;
  const parsed = parseLogic(source);
  if (!parsed.ok) return false;
  const { conditions, joins } = parsed.logic;
  let result = false;
  conditions.forEach((condition, index) => {
    const value = compare(
      resolve(condition.left, record),
      condition.operator,
      resolve(condition.right, record)
    );
    if (index === 0) result = value;
    else result = joins[index - 1] === "&" ? result && value : result || value;
  });
  return result;
}

/** The columns an expression reads — what a form must re-evaluate it on. */
export function logicVariables(source: string | null | undefined): string[] {
  if (!source || !source.trim()) return [];
  const parsed = parseLogic(source);
  return parsed.ok ? parsed.logic.variables : [];
}

export interface FieldLogicFlags {
  is_displayed?: boolean | null;
  is_read_only?: boolean | null;
  is_mandatory?: boolean | null;
  display_logic?: string | null;
  read_only_logic?: string | null;
  mandatory_logic?: string | null;
}

export interface FieldLogicState {
  displayed: boolean;
  readOnly: boolean;
  mandatory: boolean;
}

/**
 * What a field is, for this record, once its logic has run. Compiere's rules:
 *
 * - displayed: the field's flag, and then its display logic if it has one;
 * - read-only: the flag, or the read-only logic;
 * - mandatory: the flag, or the mandatory logic — and only while displayed,
 *   because a value nobody can see is not one anybody can be made to enter.
 */
export function fieldLogicState(
  field: FieldLogicFlags,
  record: Record<string, unknown>
): FieldLogicState {
  const displayed =
    field.is_displayed !== false && evaluateLogic(field.display_logic, record, true);
  const readOnly = field.is_read_only === true || evaluateLogic(field.read_only_logic, record);
  const mandatory =
    displayed && (field.is_mandatory === true || evaluateLogic(field.mandatory_logic, record));
  return { displayed, readOnly, mandatory };
}

export interface FieldLogicField extends FieldLogicFlags {
  column_name: string;
  name?: string | null;
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === "";
}

/**
 * Whether two values of one column are the same value. A stored row and a
 * request body spell the same value differently — a Date against its ISO text,
 * `12.50` against `12.5`, `true` against `"Y"` — and only a real change counts.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (isBlank(a) && isBlank(b)) return true;
  const left = contextValue(a);
  const right = contextValue(b);
  if (left === right) return true;
  const l = asNumber(left);
  const r = asNumber(right);
  if (l !== null && r !== null) return l === r;
  if (/^\d{4}-\d{2}-\d{2}/.test(left) && /^\d{4}-\d{2}-\d{2}/.test(right)) {
    const lt = Date.parse(left);
    const rt = Date.parse(right);
    if (!Number.isNaN(lt) && !Number.isNaN(rt)) return lt === rt;
  }
  return false;
}

/**
 * What the API refuses, given a field list carrying the dictionary's logic.
 *
 * - `record` is the row as it will be saved (on an update, the stored row with
 *   the change applied). A displayed field whose mandatory logic is true for it
 *   must have a value. The static `is_mandatory` flag is not judged here: each
 *   stack already refuses a missing required column, and saying it twice names
 *   one mistake as two.
 * - `stored` is the row before the update, or absent on a create. A field whose
 *   read-only logic is true for it may not be changed by `changes`.
 *
 * Display logic never refuses anything: a hidden field is not a forbidden one.
 */
export function logicViolations(
  fields: FieldLogicField[],
  record: Record<string, unknown>,
  changes: Record<string, unknown>,
  stored?: Record<string, unknown> | null
): string[] {
  const errors: string[] = [];
  for (const field of fields) {
    const label = field.name || field.column_name;
    if (field.mandatory_logic && field.mandatory_logic.trim()) {
      const displayed =
        field.is_displayed !== false && evaluateLogic(field.display_logic, record, true);
      if (
        displayed &&
        evaluateLogic(field.mandatory_logic, record) &&
        isBlank(record[field.column_name])
      ) {
        errors.push(`${label} is required when ${field.mandatory_logic.trim()}`);
      }
    }
    if (
      stored &&
      field.read_only_logic &&
      field.read_only_logic.trim() &&
      Object.prototype.hasOwnProperty.call(changes, field.column_name) &&
      !sameValue(changes[field.column_name], stored[field.column_name]) &&
      evaluateLogic(field.read_only_logic, stored)
    ) {
      errors.push(`${label} is read-only when ${field.read_only_logic.trim()}`);
    }
  }
  return errors;
}
