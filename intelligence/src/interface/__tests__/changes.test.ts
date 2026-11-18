import { expect, test } from "bun:test";
import { ChangeHub } from "../changes";

test("stopping twice does not unsubscribe a later listener for the same owner", () => {
  const hub = new ChangeHub();
  const stopA = hub.subscribe("alice@example.org", () => {});
  stopA();
  const seen: string[] = [];
  hub.subscribe("Alice@example.org", (change) => seen.push(change.operation));
  stopA();
  hub.publish("alice@example.org", { operation: "deleted", threadId: "t" });
  expect(seen).toEqual(["deleted"]);
});
