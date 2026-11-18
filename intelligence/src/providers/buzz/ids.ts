/**
 * Buzz addresses channels and artifacts by UUID; CopilotKit and OpenBot name a thread with any
 * string. Every Buzz id here is derived from ours by a namespaced SHA-256, so the same thread always
 * lands on the same channel and the same run part on the same artifact. That is what makes
 * recording a run twice a no-op: the second create names an identity the relay already holds.
 */
import { createHash } from "node:crypto";

export function derivedUuid(namespace: string, value: string): string {
  const hex = createHash("sha256").update(`appwithai/${namespace}\0${value}`).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const channelFor = (threadId: string) => derivedUuid("thread-channel", threadId);
export const threadRecordFor = (threadId: string) => derivedUuid("thread-record", threadId);
export const runPartFor = (threadId: string, runId: string, part: number) => derivedUuid("run-part", `${threadId}\0${runId}\0${part}`);
