/**
 * The state field and the record lifecycle — stated once.
 *
 * Every record has a lifecycle: it is saved in **Draft**, moves through the
 * statuses its model draws, and ends **Final**. When workflows fail on the way
 * out of Draft it is put in **Error**, with the reason, and saving it again
 * starts over.
 *
 * - An entity with a `kind: state` workflow keeps its lifecycle in its state
 *   field — `status`, else `state`, else `stage`, whichever it declares first.
 *   Its values are `draft`, the machine's own states, and `error`. Every state
 *   the diagram ends (`x --> [*]`) is Final: `closed_won` and `closed_lost` stay
 *   as stored values, so reports and rules that name them keep working.
 * - An entity with no machine keeps it in `doc_status`: `draft`, `final`, `error`.
 *
 * A person moves a record with an action button along an edge the diagram
 * draws, if one of their roles may make that move (`%%rbac role:x on
 * Entity.<event>`); a move no `%%rbac` line names is open to anyone who may
 * update the entity. Nobody types a state into a form: the field is written by
 * the save pipeline, a button, or a workflow moving along a drawn edge.
 *
 * This is the only statement of these names. The checker, the generator, the
 * NestJS seeds and the browser runtime all ask it. Pure — no `node:` imports — so
 * the browser bundles carry it too.
 */

/** Column names that hold a state machine's current state, in priority order. */
export const STATE_FIELD_CANDIDATES = ["status", "state", "stage"] as const;

/**
 * The state field among `columns`, or `undefined` when there is none.
 *
 * Only meaningful for an entity that has a `kind: state` workflow: on any other
 * entity a `status` column is ordinary data that a person may edit.
 */
export function stateFieldOf(columns: Iterable<string>): string | undefined {
  const names = new Set(columns);
  return STATE_FIELD_CANDIDATES.find((candidate) => names.has(candidate));
}

/** The error code a direct write of the lifecycle column is refused with: it moves by buttons. */
export const STATE_FIELD_REFUSAL_CODE = "STATE_FIELD_SYSTEM_MANAGED";

/** Where every record starts. A machine that draws its own draft state reuses it (`draftValueFor`). */
export const LIFECYCLE_DRAFT = "draft";
/** The end of an entity with no state machine. On a machine every end state is Final. */
export const LIFECYCLE_FINAL = "final";
/** Where a record goes when its Draft workflows fail. Saving it again starts over. */
export const LIFECYCLE_ERROR = "error";
/** The column that holds the lifecycle of an entity with no state machine. */
export const DOC_STATUS_COLUMN = "doc_status";
/** The reserved `%%rbac` event that moves a Final record back to Draft. */
export const REOPEN_EVENT = "reopen";
/** State names a model may not draw, because the lifecycle gives them their meaning. */
export const RESERVED_STATE_NAMES = [LIFECYCLE_FINAL, LIFECYCLE_ERROR] as const;

/** The parts of a compiled state machine the lifecycle reads. */
export interface LifecycleMachine {
  states: Array<{ name: string }>;
  initial?: string;
  terminal: string[];
}

/**
 * The value Draft is stored as on this entity: the machine's own draft state when
 * it draws one under any spelling (`draft`, `DRAFT`), else `draft`. A model that
 * already starts its records in a draft state keeps that state as the lifecycle's
 * Draft rather than gaining a second one.
 */
export function draftValueFor(machine?: LifecycleMachine): string {
  const own = machine?.states.find((state) => state.name.toLowerCase() === LIFECYCLE_DRAFT);
  return own?.name ?? LIFECYCLE_DRAFT;
}

/**
 * Every value the lifecycle column may hold, in the order a record meets them.
 *
 * With no machine: `draft`, `final`, `error`. With one: Draft (the machine's own
 * draft state, if it draws one), the machine's states as drawn, `error`.
 *
 * `final` and `error` are reserved as stored values (EML509), compared exactly: a
 * hospital's `FINAL` report status is a different value and an ordinary state.
 */
export function lifecycleValuesFor(machine?: LifecycleMachine): string[] {
  if (!machine) return [LIFECYCLE_DRAFT, LIFECYCLE_FINAL, LIFECYCLE_ERROR];
  const values = [draftValueFor(machine)];
  for (const state of machine.states) {
    if (!values.includes(state.name)) values.push(state.name);
  }
  if (!values.includes(LIFECYCLE_ERROR)) values.push(LIFECYCLE_ERROR);
  return values;
}

/** True when `value` is a Final value: `final`, or any state the machine ends. */
export function isFinalValue(value: string | null | undefined, machine?: LifecycleMachine): boolean {
  if (!value) return false;
  return machine ? machine.terminal.includes(value) : value === LIFECYCLE_FINAL;
}

/**
 * A transition event in the one-token form a directive writes it in: `close won`,
 * `Close-Won` and `close_won` are one event.
 */
export function normalizeEvent(event: string): string {
  return event
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/**
 * What a button says: the status it moves the record to ("To be reviewed"). The
 * edge's event stays the move's name for `%%rbac`, the history and the API, and
 * is not part of the label — the person pressing it is choosing where the
 * record goes, and the workflows bound to that status run behind it.
 */
export function moveLabel(_event: string | undefined, to: string): string {
  const words = to.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  // An id written in capitals (`QUALIFICATION`) reads as a word, not a shout.
  const text = words === words.toUpperCase() ? words.toLowerCase() : words;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
