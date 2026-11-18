/**
 * CopilotKit's `AgentRunner`, over the Intelligence interface.
 *
 * It replaces `durable.ts`, which wrapped CopilotKit's in-memory runner and reached into its
 * internal store (`ɵGLOBAL_STORE`) to write threads behind it and load them back. This one keeps
 * nothing durable itself and uses no CopilotKit internals: a thread, its owner and every finished
 * run live in whichever provider it is given (Buzz in production, memory in tests).
 *
 * What it does keep is the state of a run in progress, as CopilotKit's own runner does: who is
 * running on which thread, the events streamed so far (so a second tab that connects mid-run sees
 * the whole run), and a stop. That state is per process; one replica serves a thread's run.
 *
 * Its behaviour follows `InMemoryAgentRunner` in @copilotkit/runtime 1.88.0 point for point: a
 * thread is owned by whoever ran it first; a run on someone else's thread is refused with
 * `ThreadAccessDeniedError`; a second run on a busy thread with `ThreadAlreadyRunningError`; a
 * finished run is recorded as its compacted events plus the agent's message snapshot; `connect`
 * replays every recorded run's compacted events and then the live tail of a run in progress.
 */
import { type BaseEvent, EventType, compactEvents, type Message } from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  ThreadAccessDeniedError,
  ThreadAlreadyRunningError,
  finalizeRunEvents,
} from "@copilotkit/runtime/v2";
import { Observable, ReplaySubject } from "rxjs";
import { type Intelligence, type RecordedRun, ThreadExistsError } from "../interface/types";

/** The owner a call names; a call naming none acts as the server, which no HTTP caller can be. */
const SERVER_OWNER = "\0server";
const ownerOf = (ownerId: string | undefined) => (ownerId ?? SERVER_OWNER).toLowerCase();

interface LiveRun {
  owner: string;
  runId: string;
  agent: AgentRunnerRunRequest["agent"];
  subject: ReplaySubject<BaseEvent>;
  stopRequested: boolean;
}

export interface IntelligenceRunnerOptions {
  /** Called when a finished run could not be recorded after every retry. Defaults to console.error. */
  onRecordFailure?: (error: unknown, context: { threadId: string; runId: string }) => void;
  /** Delays between record attempts, in ms. */
  retryDelaysMs?: number[];
}

const messageIdOf = (event: BaseEvent): string | undefined => {
  const id = (event as unknown as { messageId?: unknown }).messageId;
  return typeof id === "string" ? id : undefined;
};

export class IntelligenceRunner extends AgentRunner {
  private readonly live = new Map<string, LiveRun>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly intelligence: Intelligence,
    private readonly options: IntelligenceRunnerOptions = {}
  ) {
    super();
  }

  /**
   * False only when the thread is someone else's. A thread nobody holds yet is accessible: the
   * first run claims it. Implementing this is the runner's promise that run, connect, stop and
   * isRunning all honour the owner the same way.
   */
  override async isThreadAccessible(threadId: string, scope: { ownerId: string }): Promise<boolean> {
    const owner = ownerOf(scope.ownerId);
    const live = this.live.get(threadId);
    if (live) return live.owner === owner;
    if (await this.intelligence.threads.get(owner, threadId)) return true;
    // Not theirs: either nobody holds it (accessible, the run will claim it) or someone else
    // does. The provider answers both as "absent", so the run settles it: claiming a taken id fails.
    return true;
  }

  override run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const owner = ownerOf(request.ownerId);
    const current = this.live.get(request.threadId);
    if (current) {
      if (current.owner !== owner) throw new ThreadAccessDeniedError();
      throw new ThreadAlreadyRunningError();
    }
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    const liveRun: LiveRun = { owner, runId: request.input.runId, agent: request.agent, subject, stopRequested: false };
    this.live.set(request.threadId, liveRun);

    const task = this.execute(request, owner, liveRun).finally(() => {
      if (this.live.get(request.threadId) === liveRun) this.live.delete(request.threadId);
    });
    this.track(task);
    return subject.asObservable();
  }

  private async execute(request: AgentRunnerRunRequest, owner: string, liveRun: LiveRun): Promise<void> {
    const { subject } = liveRun;
    const agentId = request.agent.agentId ?? "default";
    let history: RecordedRun[];
    try {
      if (!(await this.intelligence.threads.get(owner, request.threadId))) {
        try {
          await this.intelligence.threads.create(owner, { threadId: request.threadId, agentId });
        } catch (error) {
          if (error instanceof ThreadExistsError) throw new ThreadAccessDeniedError();
          throw error;
        }
      }
      history = await this.intelligence.runs.list(owner, request.threadId);
    } catch (error) {
      subject.error(error);
      return;
    }

    const historicMessageIds = new Set<string>();
    for (const run of history) {
      for (const message of run.messages) historicMessageIds.add(message.id);
      for (const event of run.events) {
        const id = messageIdOf(event as BaseEvent);
        if (id) historicMessageIds.add(id);
      }
    }
    const newMessages = (messages: Message[] | undefined) => messages?.filter((m) => !historicMessageIds.has(m.id));
    const parentRunId = history.length > 0 ? history[history.length - 1]!.runId : null;
    const events: BaseEvent[] = [];
    const emit = (event: BaseEvent) => {
      events.push(event);
      subject.next(event);
    };

    let interruption: string | undefined;
    try {
      await request.agent.runAgent(request.input, {
        onEvent: ({ event }) => {
          if (event.type === EventType.RUN_STARTED && !(event as { input?: unknown }).input) {
            (event as { input?: unknown }).input = { ...request.input, messages: newMessages(request.input.messages) };
          }
          emit(event);
        },
      });
    } catch (error) {
      interruption = error instanceof Error ? error.message : String(error);
    }

    if (liveRun.stopRequested && !events.some((event) => event.type === EventType.RUN_STARTED)) {
      const started = {
        type: EventType.RUN_STARTED,
        threadId: request.threadId,
        runId: request.input.runId,
        input: { ...request.input, messages: newMessages(request.input.messages) },
      } as BaseEvent;
      events.unshift(started);
      subject.next(started);
    }
    for (const event of finalizeRunEvents(events, {
      stopRequested: liveRun.stopRequested,
      protocolVersion: request.input.protocolVersion,
      ...(interruption !== undefined ? { interruptionMessage: interruption } : {}),
    })) {
      emit(event);
    }

    if (interruption === undefined || events.length > 0 || liveRun.stopRequested) {
      const run: RecordedRun = {
        runId: request.input.runId,
        agentId,
        parentRunId,
        events: compactEvents(events) as unknown as RecordedRun["events"],
        messages: Array.isArray(request.agent.messages) ? (structuredClone(request.agent.messages) as RecordedRun["messages"]) : [],
        createdAt: Date.now(),
      };
      // Recorded before the stream completes, so a client that reconnects the moment it sees the
      // end finds the run in the history rather than missing it.
      await this.record(owner, request.threadId, run);
    }
    subject.complete();
  }

  /** Record a finished run, retrying a provider that is briefly unavailable; report it if it never takes. */
  private async record(owner: string, threadId: string, run: RecordedRun): Promise<void> {
    const delays = this.options.retryDelaysMs ?? [250, 1000, 4000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.intelligence.runs.record(owner, threadId, run);
        return;
      } catch (error) {
        if (attempt >= delays.length) {
          (this.options.onRecordFailure ?? ((e, c) => console.error("intelligence: could not record run", c, e)))(error, {
            threadId,
            runId: run.runId,
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }

  override connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const owner = ownerOf(request.ownerId);
    return new Observable<BaseEvent>((subscriber) => {
      let cancelled = false;
      let liveSubscription: { unsubscribe(): void } | undefined;
      void (async () => {
        const live = this.live.get(request.threadId);
        if (live && live.owner !== owner) {
          subscriber.complete();
          return;
        }
        const history = await this.intelligence.runs.list(owner, request.threadId);
        if (cancelled) return;
        const emitted = new Set<string>();
        for (const event of compactEvents(history.flatMap((run) => run.events) as unknown as BaseEvent[])) {
          const id = messageIdOf(event);
          if (id) emitted.add(id);
          subscriber.next(event);
        }
        const stillLive = this.live.get(request.threadId);
        if (!stillLive || stillLive.owner !== owner) {
          subscriber.complete();
          return;
        }
        liveSubscription = stillLive.subject.subscribe({
          next: (event) => {
            const id = messageIdOf(event);
            if (id && emitted.has(id)) return;
            subscriber.next(event);
          },
          complete: () => subscriber.complete(),
          error: (error) => subscriber.error(error),
        });
      })().catch((error) => subscriber.error(error));
      return () => {
        cancelled = true;
        liveSubscription?.unsubscribe();
      };
    });
  }

  override async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    const live = this.live.get(request.threadId);
    return Boolean(live && live.owner === ownerOf(request.ownerId));
  }

  override async stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    const live = this.live.get(request.threadId);
    if (!live || live.owner !== ownerOf(request.ownerId)) return false;
    if (request.runId !== undefined && live.runId !== request.runId) return false;
    if (live.stopRequested) return false;
    live.stopRequested = true;
    try {
      live.agent.abortRun();
      return true;
    } catch {
      live.stopRequested = false;
      return false;
    }
  }

  /** Resolves when every run started so far has finished and been recorded. For tests and shutdown. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private track(task: Promise<void>) {
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }
}
