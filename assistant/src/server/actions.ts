/**
 * Changes the assistant proposes and the person confirms.
 *
 * A write tool never writes. It checks that the change is one this person may
 * make right now, files it here under a random id, and tells the model that
 * nothing has happened yet. The chat draws the proposal as a card; only the
 * person pressing Confirm — a request of their own, carrying their own
 * session — runs it, once. The model cannot confirm, and a language model's
 * words are never what authorises a change.
 *
 * What runs on confirmation is the application's own call (the record's action
 * button, or a save), so its guards, rules, workflows and version check answer
 * as they would for the browser.
 */
import type { AppClient } from "./products";
import { randomToken } from "./signing";

export type Scalar = string | number | boolean | null;

export type Change =
  | { kind: "move"; object: string; id: string; event: string; label: string; to: string; title: string }
  | { kind: "update"; object: string; id: string; changes: Record<string, Scalar>; title: string };

export interface PendingAction {
  id: string;
  user: string;
  change: Change;
  /** One sentence for the card, built here from the validated change — never from model prose. */
  summary: string;
  expiresAt: number;
}

export const summarise = (change: Change): string =>
  change.kind === "move"
    ? `Press “${change.label}” on ${change.title} (moves it to ${change.to}).`
    : `Change ${change.title}: ${Object.entries(change.changes)
        .map(([field, value]) => `${field} → ${value === null ? "(empty)" : String(value)}`)
        .join(", ")}.`;

export class ActionStore {
  private readonly pending = new Map<string, PendingAction>();

  constructor(
    private readonly ttlSeconds: number,
    private readonly clock: () => number = Date.now
  ) {}

  propose(user: string, change: Change): PendingAction {
    this.sweep();
    const action: PendingAction = {
      id: randomToken(16),
      user: user.toLowerCase(),
      change,
      summary: summarise(change),
      expiresAt: this.clock() + this.ttlSeconds * 1000,
    };
    this.pending.set(action.id, action);
    return action;
  }

  /** Remove and return the proposal if it is this person's and still fresh. A wrong caller spends nothing. */
  take(id: string, user: string): PendingAction | null {
    const action = this.pending.get(id);
    if (!action || action.user !== user.toLowerCase()) return null;
    this.pending.delete(id);
    return action.expiresAt > this.clock() ? action : null;
  }

  private sweep(): void {
    const now = this.clock();
    for (const [id, action] of this.pending) if (action.expiresAt <= now) this.pending.delete(id);
  }
}

export interface Outcome {
  ok: boolean;
  message: string;
}

/** Run a confirmed change as the person. A refusal is reported in the application's own words. */
export async function execute(app: AppClient, change: Change): Promise<Outcome> {
  try {
    const record = await app.record(change.object, change.id);
    const version = Number(record?.version);
    if (!Number.isInteger(version)) return { ok: false, message: "That record cannot be changed this way." };
    if (change.kind === "move") {
      await app.move(change.object, change.id, change.event, version);
      return { ok: true, message: `Done: ${change.label}.` };
    }
    await app.update(change.object, change.id, change.changes, version);
    return { ok: true, message: "Saved." };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Refused";
    return { ok: false, message: `The application did not accept it: ${message}` };
  }
}
