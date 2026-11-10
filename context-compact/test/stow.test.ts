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

// ---- persistence ----
import fsReal from "node:fs";
import os from "node:os";
import path from "node:path";
import { STOW_MAX_AGE_MS, isValidAgentId } from "../shared/stow.ts";

const ID = "0a1b2c3d-1111-2222-3333-444455556666";
function persisted(dir: string, clock = { t: 1_000_000 }, log: string[] = []) {
  const calls: string[] = [];
  const stow = createStow(
    {
      sendClear: async (id) => void calls.push(`clear:${id}`),
      waitIdle: async (id) => void calls.push(`idle:${id}`),
      sendText: async (id, t) => void calls.push(`text:${id}:${t}`),
    },
    { dir, fs: fsReal, maxAgeMs: STOW_MAX_AGE_MS, now: () => clock.t, log: (m) => log.push(m) },
  );
  return { stow, calls, clock, log };
}
const tmpDir = () => path.join(fsReal.mkdtempSync(path.join(os.tmpdir(), "stow-")), "stow");

test("persists (0600/0700), survives restart, delivers, removes file", async () => {
  const dir = tmpDir();
  persisted(dir).stow.stow(ID, "notes");
  const file = path.join(dir, `${ID}.json`);
  assert.equal(fsReal.statSync(file).mode & 0o777, 0o600);
  assert.equal(fsReal.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(Object.keys(JSON.parse(fsReal.readFileSync(file, "utf8"))).sort(), ["stowedAt", "text"]);
  assert.deepEqual(fsReal.readdirSync(dir), [`${ID}.json`]); // no temp leftovers

  const { stow, calls } = persisted(dir); // simulated restart
  assert.equal(stow.has(ID), false);
  assert.equal(stow.load(), 1);
  assert.equal(await stow.onTurnEnded(ID, "completed"), true);
  assert.deepEqual(calls, [`clear:${ID}`, `idle:${ID}`, `text:${ID}:notes`]);
  assert.equal(fsReal.existsSync(file), false);
});

test("file is removed before sending", async () => {
  const dir = tmpDir();
  const clock = { t: 5 };
  const s = createStow(
    { sendClear: async () => { throw new Error("boom"); }, waitIdle: async () => {}, sendText: async () => {} },
    { dir, fs: fsReal, maxAgeMs: STOW_MAX_AGE_MS, now: () => clock.t },
  );
  s.stow(ID, "x");
  await assert.rejects(s.onTurnEnded(ID, "completed"));
  assert.deepEqual(fsReal.readdirSync(dir), []);
});

test("stale note dropped at load and at turn end", async () => {
  const dir = tmpDir();
  const a = persisted(dir);
  a.stow.stow(ID, "old");
  const b = persisted(dir, { t: a.clock.t + STOW_MAX_AGE_MS + 1 });
  assert.equal(b.stow.load(), 0);
  assert.deepEqual(fsReal.readdirSync(dir), []);

  const c = persisted(dir);
  c.stow.stow(ID, "old2");
  c.clock.t += STOW_MAX_AGE_MS + 1;
  assert.equal(await c.stow.onTurnEnded(ID, "completed"), false);
  assert.deepEqual(c.calls, []);
  assert.deepEqual(fsReal.readdirSync(dir), []);
});

test("corrupt file dropped with a log line", () => {
  const dir = tmpDir();
  fsReal.mkdirSync(dir, { recursive: true });
  fsReal.writeFileSync(path.join(dir, `${ID}.json`), "{not json");
  const { stow, log } = persisted(dir);
  assert.equal(stow.load(), 0);
  assert.deepEqual(fsReal.readdirSync(dir), []);
  assert.equal(log.length, 1);
});

test("bad agent ids are rejected and never touch the filesystem", () => {
  const dir = tmpDir();
  const { stow } = persisted(dir);
  for (const bad of ["../x", "a/b", "", "..", "id with space", `${ID}/../../e`]) {
    assert.equal(isValidAgentId(bad), false);
    assert.equal(stow.stow(bad, "t").ok, false);
  }
  assert.equal(fsReal.existsSync(dir), false);
});
