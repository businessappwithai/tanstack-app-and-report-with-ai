/**
 * Thread-change notifications within one process, shared by every provider.
 *
 * A provider publishes after a write it made has been accepted; listeners are the open
 * `conversation-events` sockets of that owner. A listener that throws is dropped rather than
 * allowed to stop the others. Changes made by another replica are not seen here; the client's
 * list refetch covers that until a relay subscription replaces this.
 */
import type { ThreadChange, ThreadChanges } from "./types";

export class ChangeHub implements ThreadChanges {
  private readonly listeners = new Map<string, Set<(change: ThreadChange) => void>>();

  subscribe(owner: string, listener: (change: ThreadChange) => void): () => void {
    const key = owner.toLowerCase();
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    let stopped = false;
    return () => {
      // Idempotent, and never removes a set a later subscription made: a socket's close and error
      // handlers can both call this.
      if (stopped) return;
      stopped = true;
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(key) === set) this.listeners.delete(key);
    };
  }

  publish(owner: string, change: ThreadChange): void {
    const set = this.listeners.get(owner.toLowerCase());
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(change);
      } catch {
        set.delete(listener);
      }
    }
  }
}
