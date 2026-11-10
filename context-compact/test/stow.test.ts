import { test } from "node:test";
import assert from "node:assert/strict";
import { createStow, STOW_ACK } from "../shared/stow.ts";

function fake() {
  const log: string[] = [];
  const stow = createStow({
    sendClear: async (id) => void log.push(`clear:${id}`),
    waitIdle: async (id) => void log.push(`idle:${id}`),
    sendText: async (id, t) => void log.push(`text:${id}:${t}`),
  });
  return { stow, log };
}

test("stow acks and rejects empty text", () => {
  const { stow } = fake();
  assert.equal(stow.stow("a", "hi").message, STOW_ACK);
  assert.equal(stow.stow("a", "   ").ok, false);
  assert.equal(stow.stow("b", "").ok, false);
  assert.equal(stow.has("b"), false);
});

test("clear, wait idle, then text — in that order", async () => {
  const { stow, log } = fake();
  stow.stow("a", "notes");
  assert.equal(await stow.onTurnEnded("a", "completed"), true);
  assert.deepEqual(log, ["clear:a", "idle:a", "text:a:notes"]);
});

test("second stow replaces the first", async () => {
  const { stow, log } = fake();
  stow.stow("a", "one");
  stow.stow("a", "two");
  await stow.onTurnEnded("a", "completed");
  assert.deepEqual(log, ["clear:a", "idle:a", "text:a:two"]);
});

test("one-shot: second turn end does nothing", async () => {
  const { stow, log } = fake();
  stow.stow("a", "x");
  await stow.onTurnEnded("a", "completed");
  log.length = 0;
  assert.equal(await stow.onTurnEnded("a", "completed"), false);
  assert.deepEqual(log, []);
});

test("entry is deleted before sending (a failing clear does not retry)", async () => {
  const s = createStow({
    sendClear: async () => { throw new Error("boom"); },
    waitIdle: async () => {},
    sendText: async () => {},
  });
  s.stow("a", "x");
  await assert.rejects(s.onTurnEnded("a", "completed"));
  assert.equal(s.has("a"), false);
});

test("other agents and non-completed outcomes are ignored", async () => {
  const { stow, log } = fake();
  stow.stow("a", "x");
  assert.equal(await stow.onTurnEnded("b", "completed"), false);
  assert.equal(await stow.onTurnEnded("a", "failed"), false);
  assert.deepEqual(log, []);
  assert.equal(stow.has("a"), true);
});
