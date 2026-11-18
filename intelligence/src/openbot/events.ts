/**
 * OpenBot's `conversation-events` socket (`api/asyncapi.yaml`, channel `conversationEvents`): what
 * changed in the signed-in person's conversations, as it happens. The server only sends; anything a
 * client sends is ignored. Nothing is replayed: on opening, the app reads its conversations afresh
 * over REST, so a change made while it was away is not lost, only not pushed.
 *
 * The changes are the Intelligence interface's own (`changes.subscribe`), mapped to OpenBot's
 * `ConversationActivity` message.
 */
import type { Server, ServerWebSocket } from "bun";
import type { Intelligence, ThreadChange } from "../interface/types";

export const CONVERSATION_EVENTS_PATH = "/api/v2/organizations/default/conversation-events";

export interface Connection {
  owner: string;
  stop?: () => void;
}

export function activityOf(owner: string, change: ThreadChange): Record<string, unknown> {
  if (change.operation === "deleted") {
    return { channelId: change.threadId, memberIds: [owner], lastMessage: null, lastMessageAt: null, lastMessageAgentId: null, deleted: true };
  }
  const thread = change.thread;
  const last = thread.lastMessage;
  return {
    channelId: thread.id,
    memberIds: [owner],
    lastMessage: last?.text ?? null,
    lastMessageAt: last?.at ?? thread.lastRunAt,
    lastMessageAgentId: last && last.by !== "person" ? last.by.agentId : null,
    summary: thread.name,
    pinned: thread.pinned,
  };
}

export function createConversationEvents(intelligence: Intelligence) {
  return {
    /** Bun's websocket handlers for `Bun.serve`. */
    websocket: {
      open(ws: ServerWebSocket<Connection>) {
        ws.data.stop = intelligence.changes.subscribe(ws.data.owner, (change) => {
          ws.send(JSON.stringify(activityOf(ws.data.owner, change)));
        });
      },
      message() {
        // The channel is send-only; a client's messages are ignored, as the contract says.
      },
      close(ws: ServerWebSocket<Connection>) {
        ws.data.stop?.();
      },
    },
    /** Upgrade a request for the person it names; false when it is not an upgrade this serves. */
    upgrade(request: Request, server: Server<Connection>, owner: string): boolean {
      return server.upgrade(request, { data: { owner } satisfies Connection });
    },
  };
}
