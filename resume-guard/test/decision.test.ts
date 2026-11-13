// Unit tests for the pure decision logic. Run: npm test  (node --test, no Paseo involved).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approxK,
  buildDenyMessage,
  resolveThreshold,
  shouldBlockResume,
  type ResumeSnapshot,
} from "../shared/decision.ts";
import { DEFAULT_SETTINGS, DEFAULT_THRESHOLD_TOKENS, ResumeGuardSettingsSchema } from "../shared/settings.ts";

const snap = (status: string, tokens: number | undefined): ResumeSnapshot => ({
  status,
  lastUsage: tokens === undefined ? null : { contextWindowUsedTokens: tokens },
});

// The spec's injection matrix: error+60000 blocked; error+10000 allowed; running+60000 allowed; closed+60000 allowed.

test("error + 60000 tokens > 30000 threshold: blocked", () => {
  assert.equal(shouldBlockResume(snap("error", 60_000), DEFAULT_THRESHOLD_TOKENS), true);
});

test("error + 10000 tokens < 30000 threshold: allowed", () => {
  assert.equal(shouldBlockResume(snap("error", 10_000), DEFAULT_THRESHOLD_TOKENS), false);
});

test("running + 60000 tokens: allowed", () => {
  assert.equal(shouldBlockResume(snap("running", 60_000), DEFAULT_THRESHOLD_TOKENS), false);
});

test("closed + 60000 tokens: allowed", () => {
  assert.equal(shouldBlockResume(snap("closed", 60_000), DEFAULT_THRESHOLD_TOKENS), false);
});

// Never block other statuses, whatever the token count.

test("idle and initializing at 60000 tokens: allowed", () => {
  assert.equal(shouldBlockResume(snap("idle", 60_000), DEFAULT_THRESHOLD_TOKENS), false);
  assert.equal(shouldBlockResume(snap("initializing", 60_000), DEFAULT_THRESHOLD_TOKENS), false);
});

// Threshold edge: the block is strictly above the threshold.

test("error + exactly 30000 tokens: allowed (strictly above blocks)", () => {
  assert.equal(shouldBlockResume(snap("error", 30_000), DEFAULT_THRESHOLD_TOKENS), false);
});

// Unknown snapshot pieces never block.

test("error with missing/unreadable usage: allowed", () => {
  assert.equal(shouldBlockResume({ status: "error", lastUsage: null }, DEFAULT_THRESHOLD_TOKENS), false);
  assert.equal(shouldBlockResume({ status: "error", lastUsage: {} }, DEFAULT_THRESHOLD_TOKENS), false);
  assert.equal(shouldBlockResume({ status: null, lastUsage: { contextWindowUsedTokens: 60_000 } }, DEFAULT_THRESHOLD_TOKENS), false);
});

test("custom threshold applies", () => {
  assert.equal(shouldBlockResume(snap("error", 40_000), 50_000), false);
  assert.equal(shouldBlockResume(snap("error", 60_000), 50_000), true);
});

// Settings resolution: unreadable -> default applied (never skip the guard).

test("settings unreadable (read throws / non-ready status): default 30000 applied", () => {
  assert.equal(resolveThreshold(null, DEFAULT_THRESHOLD_TOKENS), 30_000);
  assert.equal(resolveThreshold(undefined, DEFAULT_THRESHOLD_TOKENS), 30_000);
  assert.equal(resolveThreshold({ status: "error" }, DEFAULT_THRESHOLD_TOKENS), 30_000);
  assert.equal(resolveThreshold({ status: "invalid", values: { thresholdTokens: 10_000 } }, DEFAULT_THRESHOLD_TOKENS), 30_000);
});

test("settings ready with a value: value applied; ready without it: default applied", () => {
  assert.equal(resolveThreshold({ status: "ready", values: { thresholdTokens: 10_000 } }, DEFAULT_THRESHOLD_TOKENS), 10_000);
  assert.equal(resolveThreshold({ status: "ready", values: {} }, DEFAULT_THRESHOLD_TOKENS), 30_000);
});

// Message contents: names the agent id and ~Nk tokens, says do not resume, points at the handoff path.

test("deny message names agent id, ~Nk tokens, do-not-resume and handoff path", () => {
  const msg = buildDenyMessage("agent-abc123", 60_000, 30_000);
  assert.ok(msg.includes("agent-abc123"));
  assert.ok(msg.includes("~60k"));
  assert.ok(msg.includes("~30k"));
  assert.ok(msg.includes("Do not resume it"));
  assert.ok(msg.includes("<task>/workers/agent-abc123/handoff.md"));
  assert.ok(msg.includes("spawn a fresh agent"));
});

test("approxK rounds like ~Nk", () => {
  assert.equal(approxK(60_000), "~60k");
  assert.equal(approxK(30_000), "~30k");
  assert.equal(approxK(30_400), "~30k");
});

test("schema default is 30000", () => {
  assert.equal(ResumeGuardSettingsSchema.parse({}).thresholdTokens, 30_000);
  assert.equal(DEFAULT_SETTINGS.thresholdTokens, DEFAULT_THRESHOLD_TOKENS);
});
