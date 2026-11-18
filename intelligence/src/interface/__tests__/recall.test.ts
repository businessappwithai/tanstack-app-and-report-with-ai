import { describe, expect, test } from "bun:test";
import { rankMemories } from "../recall";
import type { MemorySummary } from "../types";

const memory = (id: string, content: string, extra: Partial<MemorySummary> = {}): MemorySummary => ({
  id,
  content,
  kind: "topical",
  scope: "user",
  sourceThreadIds: [],
  invalidatedAt: null,
  createdAt: `2026-11-18T00:00:0${id}.000Z`,
  ...extra,
});

describe("rankMemories", () => {
  const all = [
    memory("1", "Prefers a weekly summary"),
    memory("2", "Weekly standup on Fridays"),
    memory("3", "Lives in Porto"),
    memory("4", "Prefers a weekly summary of weekly numbers", { scope: "project" }),
    memory("5", "Weekly summary, retired", { invalidatedAt: "2026-11-18T01:00:00.000Z" }),
  ];

  test("ranks the memory holding more of the query's words first, and leaves out non-matches", () => {
    const ranked = rankMemories(all, { query: "weekly summary" });
    expect(ranked.map((m) => m.id)).toEqual(["4", "1", "2"]);
    expect(ranked.every((m) => m.score > 0)).toBe(true);
  });

  test("never returns an invalidated memory", () => {
    expect(rankMemories(all, { query: "retired" })).toEqual([]);
  });

  test("respects scope and limit, and breaks a tie by the newer memory", () => {
    expect(rankMemories(all, { query: "weekly", scope: "user" }).map((m) => m.id)).toEqual(["2", "1"]);
    expect(rankMemories(all, { query: "weekly", limit: 1 }).length).toBe(1);
  });

  test("a query of no real words recalls nothing", () => {
    expect(rankMemories(all, { query: "  ? " })).toEqual([]);
  });
});
