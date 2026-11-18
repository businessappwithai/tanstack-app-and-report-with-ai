/**
 * The Intelligence interface on a Buzz relay.
 *
 * | Interface      | On Buzz                                                                         |
 * |----------------|---------------------------------------------------------------------------------|
 * | a person       | a custodial key (`keys.ts`), admitted to the relay by the operator              |
 * | a thread       | a private stream channel (kind 9007) whose members are the person and the bot,  |
 * |                | plus an `appwithai.thread` artifact (NIP-AR, kind 45010) holding its summary    |
 * | a finished run | `appwithai.agui-batch` artifacts in that channel: part 0 the message snapshot,  |
 * |                | parts 1..n the compacted AG-UI events; the readable lines also go out as kind 9 |
 * | a memory       | an NIP-AE engram (kind 30174) from the bot to the person (`engram.ts`)          |
 *
 * Every read is made with the reader's own key, so the relay's membership check is what keeps one
 * person out of another's threads: a channel they are not in answers empty. Nothing here decides
 * access on its own.
 */
import type { Event } from "nostr-tools/pure";
import { getPublicKey } from "nostr-tools/pure";
import { ChangeHub } from "../../interface/changes";
import { rankMemories } from "../../interface/recall";
import {
  type Intelligence,
  type MemoryInput,
  type MemoryScope,
  type MemorySummary,
  type RecordedRun,
  type ThreadMessage,
  type ThreadSummary,
  ThreadExistsError,
} from "../../interface/types";
import { KIND_AGENT_ENGRAM, conversationKey, dTag, encryptBody, heads, type EngramBody } from "./engram";
import { channelFor, runPartFor, threadRecordFor } from "./ids";
import type { KeyVault } from "./keys";
import { RelayClient, RelayError } from "./relay";

const KIND_MESSAGE = 9;
const KIND_ARTIFACT = 45010;
const KIND_CREATE_CHANNEL = 9007;
const KIND_ADD_MEMBER = 9000;
const KIND_DELETE_CHANNEL = 9008;
const KIND_RELAY_ADD_MEMBER = 9030;
const TYPE_THREAD = "appwithai.thread";
const TYPE_RUN = "appwithai.agui-batch";
/** Run-event parts are kept well under the relay's 512 KiB frame. */
const PART_BYTES = 96 * 1024;
/** NIP-AR's page ceiling. A thread that reaches it is refused rather than silently truncated. */
const PAGE = 1000;

export interface BuzzIntelligenceOptions {
  /** The relay's HTTP address, as its `RELAY_URL` names it (ws:// becomes http://). */
  relayUrl: string;
  /** The relay owner's key (`RELAY_OWNER_PUBKEY`'s secret): creates channels, admits members. */
  operatorSecret: Uint8Array;
  /** The assistant's key. */
  botSecret: Uint8Array;
  keys: KeyVault;
  /** Admit each new person (and the bot) to the relay; required when the relay requires membership. */
  admitMembers?: boolean;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const nowIso = () => new Date().toISOString();
const tagValue = (event: Event, name: string) => event.tags.find((t) => t[0] === name)?.[1];
const isTaken = (error: unknown) =>
  error instanceof RelayError && /exist|taken|duplicate|already/i.test(error.message);

export function createBuzzIntelligence(options: BuzzIntelligenceOptions): Intelligence {
  const relay = new RelayClient(options.relayUrl.replace(/^ws/, "http"));
  const operator = options.operatorSecret;
  const bot = options.botSecret;
  const botPubkey = getPublicKey(bot);
  const changes = new ChangeHub();
  const admitted = new Set<string>();

  async function admit(pubkey: string): Promise<void> {
    if (!options.admitMembers || admitted.has(pubkey)) return;
    await relay.publish(operator, KIND_RELAY_ADD_MEMBER, [["p", pubkey]]);
    admitted.add(pubkey);
  }

  async function person(owner: string) {
    const key = await options.keys.keyFor(owner.toLowerCase());
    await admit(botPubkey);
    await admit(key.pubkey);
    return key;
  }

  async function current(secret: Uint8Array, d: string): Promise<Event | null> {
    const found = await relay.query(secret, [{ artifact: "current", kinds: [KIND_ARTIFACT], "#d": [d] }]);
    return found.find((event) => tagValue(event, "d") === d) ?? null;
  }

  const summaryOf = (event: Event): ThreadSummary | null => {
    try {
      const summary = JSON.parse(event.content) as ThreadSummary;
      if (typeof summary.id !== "string") return null;
      return { ...summary, pinned: summary.pinned === true, lastMessage: summary.lastMessage ?? null };
    } catch {
      return null;
    }
  };

  function artifactTags(d: string, channel: string, type: string, title: string, op: "create" | "update", prev?: string, extra: string[][] = []) {
    const tags = [["ar", "1"], ["d", d], ["h", channel], ["type", type], ["title", title.slice(0, 500) || "Conversation"], ["op", op]];
    if (prev) tags.push(["prev", prev]);
    return [...tags, ...extra];
  }

  /** Read the thread's summary artifact, change it, and write the next revision; one retry on a lost race. */
  async function revise(owner: string, threadId: string, change: (summary: ThreadSummary) => ThreadSummary): Promise<ThreadSummary | null> {
    const me = await person(owner);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const head = await current(me.secret, threadRecordFor(threadId));
      const summary = head && summaryOf(head);
      if (!head || !summary) return null;
      const next = change({ ...summary });
      try {
        await relay.publish(
          me.secret,
          KIND_ARTIFACT,
          artifactTags(threadRecordFor(threadId), channelFor(threadId), TYPE_THREAD, next.name ?? "Conversation", "update", head.id, [
            ["owner", me.pubkey],
            ["agent", next.agentId],
            ["archived", String(next.archived)],
          ]),
          JSON.stringify(next)
        );
        return next;
      } catch (error) {
        if (attempt === 0 && error instanceof RelayError && /prev|conflict|current/i.test(error.message)) continue;
        throw error;
      }
    }
    return null;
  }

  async function listRuns(owner: string, threadId: string): Promise<RecordedRun[]> {
    const me = await person(owner);
    const parts = await relay.query(me.secret, [
      { artifact: "current", kinds: [KIND_ARTIFACT], "#h": [channelFor(threadId)], "#type": [TYPE_RUN], limit: PAGE },
    ]);
    if (parts.length >= PAGE) throw new RelayError(507, "this conversation holds more run parts than one read can return");
    const byRun = new Map<string, Map<number, Event>>();
    for (const part of parts) {
      const runId = tagValue(part, "run");
      const index = Number(tagValue(part, "part"));
      if (!runId || !Number.isInteger(index)) continue;
      const set = byRun.get(runId) ?? new Map<number, Event>();
      set.set(index, part);
      byRun.set(runId, set);
    }
    const runs: RecordedRun[] = [];
    for (const [runId, set] of byRun) {
      const head = set.get(0);
      if (!head) continue; // part 0 is written last: without it the run was never completely recorded
      const total = Number(tagValue(head, "parts"));
      const meta = JSON.parse(head.content) as Omit<RecordedRun, "events">;
      const events: RecordedRun["events"] = [];
      let complete = true;
      for (let index = 1; index < total; index += 1) {
        const part = set.get(index);
        if (!part) {
          complete = false;
          break;
        }
        events.push(...(JSON.parse(part.content) as RecordedRun["events"]));
      }
      if (complete) runs.push({ ...meta, runId, events });
    }
    return runs.sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  }

  function chunk(events: RecordedRun["events"]): RecordedRun["events"][] {
    const parts: RecordedRun["events"][] = [];
    let current: RecordedRun["events"] = [];
    let size = 2;
    for (const event of events) {
      const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (bytes > PART_BYTES) throw new RelayError(413, `one run event is larger than ${PART_BYTES} bytes`);
      if (size + bytes > PART_BYTES && current.length > 0) {
        parts.push(current);
        current = [];
        size = 2;
      }
      current.push(event);
      size += bytes;
    }
    if (current.length > 0) parts.push(current);
    return parts;
  }

  const text = (message: ThreadMessage) => (typeof message.content === "string" ? message.content.trim() : "");

  // ── memory ──────────────────────────────────────────────────────────────

  async function memoryHeads(owner: string) {
    const me = await person(owner);
    const userKey = conversationKey(bot, me.pubkey);
    const projectKey = conversationKey(bot, botPubkey);
    const [userEvents, projectEvents] = await Promise.all([
      relay.query(me.secret, [{ kinds: [KIND_AGENT_ENGRAM], authors: [botPubkey], "#p": [me.pubkey], limit: PAGE }]),
      relay.query(bot, [{ kinds: [KIND_AGENT_ENGRAM], authors: [botPubkey], "#p": [botPubkey], limit: PAGE }]),
    ]);
    return [
      ...heads(userEvents, userKey, botPubkey, me.pubkey).map((h) => ({ ...h, counterparty: me.pubkey, key: userKey })),
      ...heads(projectEvents, projectKey, botPubkey, botPubkey).map((h) => ({ ...h, counterparty: botPubkey, key: projectKey })),
    ];
  }

  const memoryOf = (head: { event: Event; body: EngramBody }): MemorySummary => ({
    id: head.body.slug.slice("mem/".length),
    kind: (head.body.kind as MemorySummary["kind"]) ?? "topical",
    scope: (head.body.scope as MemoryScope) ?? "user",
    content: head.body.value ?? "",
    sourceThreadIds: Array.isArray(head.body.sourceThreadIds) ? (head.body.sourceThreadIds as string[]) : [],
    createdAt: typeof head.body.createdAt === "string" ? head.body.createdAt : iso(head.event.created_at),
    invalidatedAt: head.body.value === null ? (typeof head.body.invalidatedAt === "string" ? head.body.invalidatedAt : iso(head.event.created_at)) : null,
  });

  async function writeEngram(key: Uint8Array, counterparty: string, body: EngramBody, after = 0): Promise<void> {
    const createdAt = Math.max(Math.floor(Date.now() / 1000), after + 1);
    await relay.publish(
      bot,
      KIND_AGENT_ENGRAM,
      [["d", dTag(key, body.slug)], ["p", counterparty], ["alt", "encrypted agent memory record"]],
      encryptBody(key, body),
      createdAt
    );
  }

  async function listMemories(owner: string, listOptions: { includeInvalidated?: boolean } = {}): Promise<MemorySummary[]> {
    return (await memoryHeads(owner))
      .map(memoryOf)
      .filter((m) => listOptions.includeInvalidated || m.invalidatedAt === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function createMemory(owner: string, input: MemoryInput): Promise<MemorySummary> {
    const me = await person(owner);
    const scope = input.scope ?? "user";
    const counterparty = scope === "project" ? botPubkey : me.pubkey;
    const key = conversationKey(bot, counterparty);
    const body: EngramBody = {
      slug: `mem/${crypto.randomUUID()}`,
      value: input.content,
      kind: input.kind,
      scope,
      sourceThreadIds: [...(input.sourceThreadIds ?? [])],
      createdAt: nowIso(),
    };
    await writeEngram(key, counterparty, body);
    return memoryOf({ event: { created_at: Math.floor(Date.now() / 1000) } as Event, body });
  }

  async function retire(owner: string, id: string): Promise<boolean> {
    const live = (await memoryHeads(owner)).find((h) => h.body.slug === `mem/${id}` && h.body.value !== null);
    if (!live) return false;
    await writeEngram(live.key, live.counterparty, { ...live.body, value: null, invalidatedAt: nowIso() }, live.event.created_at);
    return true;
  }

  return {
    changes,
    threads: {
      async list(owner, listOptions = {}) {
        const me = await person(owner);
        const records = await relay.query(me.secret, [
          { artifact: "current", kinds: [KIND_ARTIFACT], "#type": [TYPE_THREAD], "#owner": [me.pubkey], limit: PAGE },
        ]);
        return records
          .map(summaryOf)
          .filter((s): s is ThreadSummary => s !== null)
          .filter((s) => listOptions.includeArchived || !s.archived)
          .filter((s) => !listOptions.agentId || s.agentId === listOptions.agentId)
          .sort((a, b) => (b.lastMessage?.at ?? b.lastRunAt ?? b.updatedAt).localeCompare(a.lastMessage?.at ?? a.lastRunAt ?? a.updatedAt))
          .slice(0, listOptions.limit && listOptions.limit > 0 ? listOptions.limit : undefined);
      },

      async create(owner, input) {
        const me = await person(owner);
        const channel = channelFor(input.threadId);
        // Creating the channel is the claim on the thread id. Members are added only after a fresh
        // create: a channel that already existed, whoever made it, refuses the id here, before anyone
        // could be added to somebody else's conversation.
        let created: { duplicate: boolean };
        try {
          created = await relay.publish(operator, KIND_CREATE_CHANNEL, [
            ["h", channel],
            ["name", `t-${channel.slice(0, 8)}`],
            ["visibility", "private"],
            ["channel_type", "stream"],
          ]);
        } catch (error) {
          if (isTaken(error)) throw new ThreadExistsError(input.threadId);
          throw error;
        }
        if (created.duplicate) throw new ThreadExistsError(input.threadId);
        const at = nowIso();
        const summary: ThreadSummary = {
          id: input.threadId,
          name: input.name ?? null,
          agentId: input.agentId,
          archived: false,
          pinned: false,
          createdAt: at,
          updatedAt: at,
          lastRunAt: null,
          lastMessage: null,
        };
        // If anything after the claim fails, give the claim back: a channel with no members and no
        // summary is reachable by nobody, and would refuse a retry of the same id for ever.
        try {
          await relay.publish(operator, KIND_ADD_MEMBER, [["h", channel], ["p", me.pubkey]]);
          await relay.publish(operator, KIND_ADD_MEMBER, [["h", channel], ["p", botPubkey]]);
          await relay.publish(
            me.secret,
            KIND_ARTIFACT,
            artifactTags(threadRecordFor(input.threadId), channel, TYPE_THREAD, summary.name ?? "Conversation", "create", undefined, [
              ["owner", me.pubkey],
              ["agent", summary.agentId],
              ["archived", "false"],
            ]),
            JSON.stringify(summary)
          );
        } catch (error) {
          await relay.publish(operator, KIND_DELETE_CHANNEL, [["h", channel]]).catch(() => undefined);
          throw error;
        }
        changes.publish(owner, { operation: "created", thread: summary });
        return { ...summary };
      },

      async get(owner, threadId) {
        const me = await person(owner);
        const head = await current(me.secret, threadRecordFor(threadId));
        return head ? summaryOf(head) : null;
      },

      async update(owner, threadId, update) {
        const next = await revise(owner, threadId, (summary) => ({
          ...summary,
          ...(update.name !== undefined ? { name: update.name } : {}),
          ...(update.archived !== undefined ? { archived: update.archived } : {}),
          ...(update.pinned !== undefined ? { pinned: update.pinned } : {}),
          ...(update.lastMessage !== undefined ? { lastMessage: { ...update.lastMessage } } : {}),
          updatedAt: nowIso(),
        }));
        if (next) changes.publish(owner, { operation: update.archived ? "archived" : "updated", thread: next });
        return next;
      },

      async delete(owner, threadId) {
        const me = await person(owner);
        const head = await current(me.secret, threadRecordFor(threadId));
        if (!head) return false;
        const channel = channelFor(threadId);
        await relay.publish(me.secret, KIND_ARTIFACT, [
          ["ar", "1"],
          ["d", threadRecordFor(threadId)],
          ["h", channel],
          ["type", TYPE_THREAD],
          ["op", "delete"],
          ["prev", head.id],
        ]);
        await relay.publish(operator, KIND_DELETE_CHANNEL, [["h", channel]]);
        changes.publish(owner, { operation: "deleted", threadId });
        return true;
      },

      async messages(owner, threadId) {
        const runs = await listRuns(owner, threadId);
        return runs.length > 0 ? runs[runs.length - 1]!.messages : [];
      },
    },

    runs: {
      async record(owner, threadId, run) {
        const me = await person(owner);
        const channel = channelFor(threadId);
        const summary = await (async () => {
          const head = await current(me.secret, threadRecordFor(threadId));
          return head ? summaryOf(head) : null;
        })();
        if (!summary) return;
        if (await current(me.secret, runPartFor(threadId, run.runId, 0))) return;

        // Lines already in the channel: those of the runs recorded before this one.
        const earlier = new Set((await listRuns(owner, threadId)).flatMap((r) => r.messages.map((m) => m.id)));

        // The exact record: event parts first, the snapshot (part 0) last, so a run is listed only
        // once all of it is there.
        const eventParts = chunk(run.events);
        const total = eventParts.length + 1;
        const partTags = (index: number) => [
          ["run", run.runId],
          ["part", String(index)],
          ["parts", String(total)],
          ["at", String(run.createdAt)],
        ];
        const title = `Run ${run.runId.slice(0, 8)}`;
        for (const [offset, events] of eventParts.entries()) {
          const index = offset + 1;
          try {
            await relay.publish(bot, KIND_ARTIFACT, artifactTags(runPartFor(threadId, run.runId, index), channel, TYPE_RUN, `${title} part ${index}`, "create", undefined, partTags(index)), JSON.stringify(events));
          } catch (error) {
            if (!isTaken(error)) throw error;
          }
        }
        const meta = { agentId: run.agentId, parentRunId: run.parentRunId, messages: run.messages, createdAt: run.createdAt };
        try {
          await relay.publish(bot, KIND_ARTIFACT, artifactTags(runPartFor(threadId, run.runId, 0), channel, TYPE_RUN, `${title} snapshot`, "create", undefined, partTags(0)), JSON.stringify(meta));
        } catch (error) {
          if (!isTaken(error)) throw error;
        }

        // The conversation, as people read it in any Buzz client: the new lines of this run. Posted
        // only once the snapshot is stored, so a retry of a run that failed part-way (which returns
        // above once part 0 exists) never posts them twice. The record is the exact copy; these
        // lines are a readable mirror of it, and a line lost to a failure here is not re-sent.
        for (const message of run.messages) {
          if (earlier.has(message.id)) continue;
          const line = text(message);
          if (!line) continue;
          if (message.role === "user") await relay.publish(me.secret, KIND_MESSAGE, [["h", channel]], line);
          else if (message.role === "assistant") await relay.publish(bot, KIND_MESSAGE, [["h", channel]], line);
        }

        const next = await revise(owner, threadId, (s) => ({ ...s, lastRunAt: new Date(run.createdAt).toISOString(), updatedAt: nowIso() }));
        if (next) changes.publish(owner, { operation: "updated", thread: next });
      },

      list: listRuns,
    },

    memory: {
      list: listMemories,
      create: createMemory,
      async supersede(owner, id, input) {
        if (!(await retire(owner, id))) return null;
        return createMemory(owner, input);
      },
      forget: retire,
      async recall(owner, query) {
        return rankMemories(await listMemories(owner), query);
      },
    },
  };
}

export { MemoryKeyVault, PostgresKeyVault, encryptionKeyFrom } from "./keys";
