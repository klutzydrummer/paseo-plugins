import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDelta, buildSeed, createRotation, LOOP_GUARD_MS, DELTA_MAX_AGE_MS, type RotationFs } from "../shared/rotation.ts";

const ID = "aaaaaaaa-1111-2222-3333-444444444444";
const row = (type: string, content: unknown, extra: object = {}) => JSON.stringify({ type, message: { content }, ...extra });
const clearRow = row("user", "<command-name>/clear</command-name>\n<command-message>clear</command-message>");

function memFs(): RotationFs & { files: Map<string, { data: string; mode?: number; mtime: number }>; t: { now: number } } {
  const files = new Map<string, { data: string; mode?: number; mtime: number }>();
  const t = { now: 1_000_000 };
  return {
    files, t,
    mkdirSync: () => undefined,
    writeFileSync: (f, data, o) => void files.set(f, { data, mode: o.mode, mtime: t.now }),
    renameSync: (a, b) => { files.set(b, files.get(a)!); files.delete(a); },
    readFileSync: (f) => { const x = files.get(f); if (!x) throw new Error("ENOENT"); return x.data; },
    readdirSync: (d) => { const out = [...files.keys()].filter((k) => k.startsWith(`${d}/`)).map((k) => k.slice(d.length + 1)); if (!out.length) throw new Error("ENOENT"); return out; },
    unlinkSync: (f) => { if (!files.delete(f)) throw new Error("ENOENT"); },
    statSync: (f) => ({ mtimeMs: files.get(f)!.mtime }),
  };
}

function harness(opts: { status?: () => string | undefined; jsonl?: string | null; capChars?: number } = {}) {
  const fs = memFs();
  const log: string[] = [];
  const rot = createRotation({
    sendClear: async (id) => void log.push(`clear:${id}`),
    waitIdle: async (id) => void log.push(`idle:${id}`),
    sendText: async (id, t) => void log.push(`text:${id}:${t}`),
    getStatus: async () => (opts.status ? opts.status() : "idle"),
    readTranscript: async () => (opts.jsonl === undefined ? "" : opts.jsonl),
    sleep: async () => { fs.t.now += 500; },
  }, { dir: "/s", fs, now: () => fs.t.now, capChars: opts.capChars });
  return { rot, fs, log };
}

// ---- delta builder
test("delta starts after the last /clear row", () => {
  const j = [row("user", "old"), clearRow, row("user", "mid"), clearRow, row("user", "fresh q"), row("assistant", [{ type: "text", text: "answer" }])].join("\n");
  const d = buildDelta(j);
  assert.equal(d.markerFound, true);
  assert.equal(d.text, "[user] fresh q\n[assistant] answer");
});

test("no marker: whole transcript, markerFound=false", () => {
  const d = buildDelta([row("user", "a"), row("assistant", [{ type: "text", text: "b" }])].join("\n"));
  assert.equal(d.markerFound, false);
  assert.equal(d.rows, 2);
});

test("tool results capped at 500 chars, text kept in full, thinking/sidechain/corrupt dropped", () => {
  const big = "x".repeat(2000);
  const long = "y".repeat(3000);
  const j = [
    clearRow,
    row("assistant", [{ type: "thinking", thinking: "secret" }, { type: "text", text: long }, { type: "tool_use", name: "Bash", input: { command: "ls" } }]),
    row("user", [{ type: "tool_result", content: [{ type: "text", text: big }] }]),
    row("assistant", [{ type: "text", text: "sidechain" }], { isSidechain: true }),
    "{not json",
  ].join("\n");
  const d = buildDelta(j);
  assert.ok(d.text.includes(long), "assistant text kept in full");
  assert.ok(d.text.includes("[tool_use Bash]"));
  const res = d.text.split("\n").find((l) => l.startsWith("[tool_result]"))!;
  assert.ok(res.startsWith(`[tool_result] ${"x".repeat(500)}…`));
  assert.ok(res.length < 600);
  assert.ok(!d.text.includes("secret") && !d.text.includes("sidechain"));
});

test("the injected handoff prompt right after /clear is not repeated in the delta", () => {
  const j = [clearRow, row("user", "HANDOFF: read /x/handoff.md"), row("user", "real")].join("\n");
  assert.equal(buildDelta(j, { skipUserPrefix: "HANDOFF: read /x/handoff.md" }).text, "[user] real");
});

// ---- seed
test("seed under cap is inline; handoff text or 'no handoff' stated", () => {
  const delta = { text: "[user] hi", rows: 1, markerFound: true };
  const a = buildSeed({ handoff: "see /h.md", delta, deltaFile: "/d.md" });
  assert.ok(a.text.includes("see /h.md") && a.text.includes("[user] hi") && a.fullDelta === undefined);
  const b = buildSeed({ handoff: null, delta, deltaFile: "/d.md" });
  assert.ok(b.text.includes("No handoff on record"));
});

test("seed over cap points to the file with 20k-piece instruction and never exceeds cap", () => {
  const delta = { text: "z".repeat(60_000), rows: 9, markerFound: true };
  const s = buildSeed({ handoff: "h", delta, deltaFile: "/state/delta/a.md" });
  assert.ok(s.text.length <= 40_000);
  assert.ok(s.text.includes("/state/delta/a.md") && s.text.includes("20k-char pieces") && s.text.includes("handoff.md"));
  assert.equal(s.fullDelta, delta.text);
});

// ---- sequencing
test("clear before seed; seed carries stowed handoff + delta", async () => {
  const { rot, log } = harness({ jsonl: [clearRow, row("user", "work item")].join("\n") });
  rot.recordHandoff(ID, "HANDOFF-PTR");
  assert.equal(await rot.onReloaded(ID, { provider: "claude", enabled: true }), "seeded");
  assert.equal(log[0], `clear:${ID}`);
  assert.equal(log[1], `idle:${ID}`);
  assert.ok(log[2].startsWith(`text:${ID}:`) && log[2].includes("HANDOFF-PTR") && log[2].includes("work item"));
  assert.equal(log.length, 3);
});

test("over-cap delta: file 0600 written, seed points at it", async () => {
  const { rot, fs, log } = harness({ jsonl: [clearRow, row("user", "q".repeat(2000))].join("\n"), capChars: 1200 });
  await rot.onReloaded(ID, { provider: "claude", enabled: true });
  const f = fs.files.get(`/s/delta/${ID}.md`)!;
  assert.ok(f.data.includes("q".repeat(2000)));
  assert.equal(f.mode, 0o600);
  assert.ok(log[2].includes(`/s/delta/${ID}.md`));
});

test("skips: busy agent, non-claude, disabled", async () => {
  const busy = harness({ status: () => "running" });
  assert.equal(await busy.rot.onReloaded(ID, { provider: "claude", enabled: true }), "skip:busy");
  assert.deepEqual(busy.log, []);
  const other = harness();
  assert.equal(await other.rot.onReloaded(ID, { provider: "codex", enabled: true }), "skip:non-claude");
  assert.equal(await other.rot.onReloaded(ID, { provider: "claude", enabled: false }), "skip:disabled");
  assert.deepEqual(other.log, []);
});

test("waits for landing: error -> idle", async () => {
  const seq = ["error", "error", "idle"];
  const { rot, log } = harness({ status: () => seq.shift() ?? "idle" });
  assert.equal(await rot.onReloaded(ID, { provider: "claude", enabled: true }), "seeded");
  assert.equal(log[0], `clear:${ID}`);
});

test("never landed: times out without sending", async () => {
  const { rot, log } = harness({ status: () => "error" });
  assert.equal(await rot.onReloaded(ID, { provider: "claude", enabled: true }), "skip:not-landed");
  assert.deepEqual(log, []);
});

test("dedupe: concurrent call skipped; second within 10 min skipped; allowed after", async () => {
  const { rot, fs, log } = harness();
  const [a, b] = await Promise.all([rot.onReloaded(ID, { provider: "claude", enabled: true }), rot.onReloaded(ID, { provider: "claude", enabled: true })]);
  assert.deepEqual([a, b].sort(), ["seeded", "skip:inflight"]);
  assert.equal(await rot.onReloaded(ID, { provider: "claude", enabled: true }), "skip:loop-guard");
  fs.t.now += LOOP_GUARD_MS + 1;
  assert.equal(await rot.onReloaded(ID, { provider: "claude", enabled: true }), "seeded");
  assert.equal(log.filter((l) => l.startsWith("clear:")).length, 2);
});

// ---- persistence
test("pending seed persisted before /clear; removed after delivery", async () => {
  const fs = memFs();
  let seenBeforeClear = false;
  const rot = createRotation({
    sendClear: async () => { seenBeforeClear = fs.files.has(`/s/pending/${ID}.json`); },
    waitIdle: async () => {},
    sendText: async () => {},
    getStatus: async () => "idle",
    readTranscript: async () => "",
  }, { dir: "/s", fs, now: () => fs.t.now });
  await rot.onReloaded(ID, { provider: "claude", enabled: true });
  assert.equal(seenBeforeClear, true);
  assert.equal(fs.files.has(`/s/pending/${ID}.json`), false);
});

test("restart mid-sequence: pending seed re-delivered by a fresh instance; phase 'seed' skips the /clear", async () => {
  const fs = memFs();
  const crash = createRotation({
    sendClear: async () => {}, waitIdle: async () => {},
    sendText: async () => { throw new Error("daemon died"); },
    getStatus: async () => "idle", readTranscript: async () => "",
  }, { dir: "/s", fs, now: () => fs.t.now });
  assert.equal(await crash.onReloaded(ID, { provider: "claude", enabled: true }), "failed");
  assert.deepEqual(JSON.parse(fs.files.get(`/s/pending/${ID}.json`)!.data).phase, "seed");

  const log: string[] = [];
  const fresh = createRotation({
    sendClear: async () => void log.push("clear"), waitIdle: async () => void log.push("idle"),
    sendText: async (_id, t) => void log.push(`text:${t.slice(0, 25)}`),
    getStatus: async () => "idle", readTranscript: async () => "",
  }, { dir: "/s", fs, now: () => fs.t.now });
  assert.equal(fresh.load(), 1);
  assert.equal(await fresh.resumePending(), 1);
  assert.deepEqual(log, ["text:[context-compact rotation"]);
  assert.equal(fs.files.has(`/s/pending/${ID}.json`), false);
});

test("persistence: last handoff survives a new instance; stale pending, handoff and delta files dropped at load", () => {
  const { rot, fs } = harness();
  rot.recordHandoff(ID, "ptr");
  fs.files.set(`/s/pending/bbbbbbbb-1.json`, { data: JSON.stringify({ text: "x", at: 0, phase: "clear" }), mtime: 0 });
  fs.files.set(`/s/delta/old.md`, { data: "d", mtime: 0 });
  fs.t.now += DELTA_MAX_AGE_MS + 1;
  fs.files.set(`/s/delta/new.md`, { data: "d", mtime: fs.t.now });
  const again = createRotation({ sendClear: async () => {}, waitIdle: async () => {}, sendText: async () => {}, getStatus: async () => "idle", readTranscript: async () => null }, { dir: "/s", fs, now: () => fs.t.now });
  assert.equal(again.load(), 0);
  assert.equal(again.lastHandoff(ID), "ptr");
  assert.equal(fs.files.has("/s/delta/old.md"), false);
  assert.equal(fs.files.has("/s/delta/new.md"), true);
  assert.equal(fs.files.has("/s/pending/bbbbbbbb-1.json"), false);
});

test("never-stowed agent: seed says no handoff exists", async () => {
  const { rot, log } = harness({ jsonl: row("user", "just work") });
  await rot.onReloaded(ID, { provider: "claude", enabled: true });
  assert.ok(log[2].includes("No handoff on record") && log[2].includes("just work"));
});
