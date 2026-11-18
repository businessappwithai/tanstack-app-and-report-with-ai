/**
 * Our engram code against NIP-AE's own reference vectors (`docs/nips/NIP-AE.md` in block/buzz), so a
 * memory we write is one Buzz's readers can find, and one of theirs is one we can read.
 */
import { describe, expect, test } from "bun:test";
import { finalizeEvent } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import { conversationKey, dTag, encryptBody, heads, KIND_AGENT_ENGRAM } from "../engram";

const seckeyA = hexToBytes("0000000000000000000000000000000000000000000000000000000000000001");
const seckeyO = hexToBytes("0000000000000000000000000000000000000000000000000000000000000002");
const pubkeyA = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const pubkeyO = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

describe("NIP-AE reference vectors", () => {
  test("the conversation key is symmetric and matches the spec", () => {
    const k = Buffer.from(conversationKey(seckeyA, pubkeyO)).toString("hex");
    expect(k).toBe("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d");
    expect(Buffer.from(conversationKey(seckeyO, pubkeyA)).toString("hex")).toBe(k);
  });

  test("the d tag of each slug matches the spec", () => {
    const k = conversationKey(seckeyA, pubkeyO);
    expect(dTag(k, "core")).toBe("bdc233238ffe52e272b44cc233c8f33a2bc510b08be04495b225964283be4a90");
    expect(dTag(k, "mem/example")).toBe("72d4f9629106451505d7d341ea85bb3ebad4f654fcfd2aad100d5a35f8a85cba");
    expect(dTag(k, "mem/notes/2026-05-12")).toBe("31651571a312780cfdc1f0b706b682ac9f3f51a053e8dca76fe57710bae5a4d4");
  });
});

describe("head selection", () => {
  const k = conversationKey(seckeyA, pubkeyO);
  const event = (body: object, createdAt: number, d = dTag(k, (body as { slug: string }).slug)) =>
    finalizeEvent({ kind: KIND_AGENT_ENGRAM, created_at: createdAt, tags: [["d", d], ["p", pubkeyO]], content: encryptBody(k, body as never) }, seckeyA);

  test("the newest event per slug wins, and a tombstone is kept as a null value", () => {
    const events = [
      event({ slug: "mem/a", value: "first" }, 100),
      event({ slug: "mem/a", value: "second" }, 200),
      event({ slug: "mem/b", value: "kept" }, 100),
      event({ slug: "mem/b", value: null }, 150),
    ];
    const byslug = Object.fromEntries(heads(events, k, pubkeyA, pubkeyO).map((h) => [h.body.slug, h.body.value]));
    expect(byslug).toEqual({ "mem/a": "second", "mem/b": null });
  });

  test("an event whose slug does not re-derive to its d tag, or from another author, is skipped", () => {
    const forged = event({ slug: "mem/a", value: "forged" }, 300, dTag(k, "mem/other"));
    const stranger = finalizeEvent(
      { kind: KIND_AGENT_ENGRAM, created_at: 400, tags: [["d", dTag(k, "mem/a")], ["p", pubkeyO]], content: encryptBody(k, { slug: "mem/a", value: "stranger" }) },
      seckeyO
    );
    const result = heads([event({ slug: "mem/a", value: "real" }, 100), forged, stranger], k, pubkeyA, pubkeyO);
    expect(result.map((h) => h.body.value)).toEqual(["real"]);
  });
});
