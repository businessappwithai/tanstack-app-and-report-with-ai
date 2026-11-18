/**
 * OpenBot's operations, from `operations.generated.json`, which `scripts/openbot-operations.ts`
 * writes from the pinned `api/openapi.yaml` (`bun run check:openbot-operations` fails when stale).
 */
import table from "./operations.generated.json";

export interface OpenBotOperation {
  operationId: string;
  method: string;
  /** The path as the spec writes it. */
  path: string;
  /** The same path as a regular expression; each `{parameter}` is one capture group, in order. */
  pattern: string;
  status: number;
  /** The smallest body the success schema accepts; null for a 204 or a body that is not JSON. */
  body: unknown;
}

export const OPENBOT_SPEC_COMMIT: string = table.specCommit;
export const OPENBOT_OPERATIONS: OpenBotOperation[] = table.operations as OpenBotOperation[];
