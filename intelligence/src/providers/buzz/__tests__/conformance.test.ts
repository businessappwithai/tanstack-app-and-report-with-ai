/**
 * The Buzz provider against a real relay, through the same suite the in-memory provider passes.
 *
 * Needs a running `buzz-relay` and the secret of its owner key:
 *   BUZZ_TEST_RELAY_URL=http://127.0.0.1:3300 BUZZ_TEST_OPERATOR_SECRET=<hex> bun test src/providers/buzz
 * Without them the suite is skipped and says so; CI runs it against the relay image.
 */
import { describe, test } from "bun:test";
import { generateSecretKey } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import { describeIntelligence } from "../../../interface/conformance";
import { createBuzzIntelligence, MemoryKeyVault } from "..";

const relayUrl = process.env.BUZZ_TEST_RELAY_URL;
const operator = process.env.BUZZ_TEST_OPERATOR_SECRET;

if (relayUrl && operator) {
  describeIntelligence("buzz provider", {
    make: () =>
      createBuzzIntelligence({
        relayUrl,
        operatorSecret: hexToBytes(operator),
        botSecret: generateSecretKey(),
        keys: new MemoryKeyVault(),
        admitMembers: process.env.BUZZ_TEST_ADMIT === "1",
      }),
  });
} else {
  describe("buzz provider", () => {
    test.skip("conformance against a real relay (set BUZZ_TEST_RELAY_URL and BUZZ_TEST_OPERATOR_SECRET)", () => {});
  });
}
