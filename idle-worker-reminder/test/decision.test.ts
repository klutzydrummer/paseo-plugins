import test from "node:test";
import assert from "node:assert/strict";
import { isWorker, parseDelay, reminderText } from "../shared/decision.ts";

test("worker needs parent + task/readonly label, not mm", () => {
  const a = { parentAgentId: "p" };
  assert.ok(isWorker(a, { "studio.task": "x" }));
  assert.ok(isWorker(a, { "studio.readonly": "1" }));
  assert.ok(!isWorker({ parentAgentId: null }, { "studio.task": "x" }));
  assert.ok(isWorker({ parentAgentId: null }, { "studio.task": "x", "paseo.parent-agent-id": "p" }));
  assert.ok(!isWorker(a, { "studio.task": "x", "studio.role": "mm" }));
  assert.ok(!isWorker(a, {}));
  assert.ok(!isWorker(a, undefined));
});
test("delay + text", () => {
  assert.equal(parseDelay("60000"), 60000);
  assert.equal(parseDelay("5"), null);
  assert.equal(reminderText("abcdef1234", 600000), "worker abcdef12 idle ~10 min: archive if accepted");
});
