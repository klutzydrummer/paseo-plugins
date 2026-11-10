// Dry-run tests for the nudge/compact decision logic. Run: npm test  (node --test, no Paseo involved).
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNudgeText,
  classifyPct,
  contextPct,
  isNudgeEcho,
  providerMatches,
  turnEligible,
} from "../shared/decision.ts";
import { ContextCompactSettingsSchema, compactEnv, type ContextCompactSettings } from "../shared/settings.ts";

// Settings built directly (bypassing the schema) so windows below the schema minimum can be exercised.
const mk = (over: Partial<ContextCompactSettings> = {}): ContextCompactSettings => ({
  ...ContextCompactSettingsSchema.parse({}),
  handoffPct: 50,
  compactPct: 95,
  windowTokens: 160_000,
  ...over,
});

/** What turn_ended does after the token count is known (nudge state kept by the caller). */
const verdictFor = (tokens: number, s: ContextCompactSettings, nudged = false) =>
  classifyPct(contextPct(tokens, s.windowTokens), s, nudged);

test("(a) 12k tokens, window 20000: nudge fires (60% >= 50%), compact not reached", () => {
  const s = mk({ windowTokens: 20_000 });
  assert.equal(contextPct(12_000, s.windowTokens), 60);
  assert.equal(verdictFor(12_000, s), "candidate");
});

test("(a') schema rejects windowTokens=20000 (min 50000)", () => {
  assert.equal(ContextCompactSettingsSchema.safeParse({ windowTokens: 20_000 }).success, false);
});

test("(b) 12k tokens, window 160000: 7.5% -> rounds to 8, no nudge, no compact", () => {
  const s = mk();
  assert.equal(contextPct(12_000, s.windowTokens), 8);
  assert.equal(verdictFor(12_000, s), "rearm"); // below handoffPct: nothing sent
});

test("(c) 80k at 160000: nudge exactly at 50%; 79,200 (49.5%) already rounds up to 50 and fires", () => {
  const s = mk();
  assert.equal(verdictFor(80_000, s), "candidate");
  assert.equal(verdictFor(79_199, s), "rearm"); // 49.499 -> 49
  assert.equal(verdictFor(79_200, s), "candidate"); // 49.5 -> 50 (Math.round)
});

test("(d) ~152k at 160000: compact threshold 95% -> nudge suppressed; env carries 95 / 160000", () => {
  const s = mk();
  assert.equal(verdictFor(152_000, s), "skip");
  assert.equal(verdictFor(151_199, s), "candidate"); // 94.499 -> 94
  assert.equal(verdictFor(151_200, s), "skip"); // 94.5 -> 95: skips at 94.5% already
  assert.deepEqual(compactEnv(s), {
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "95",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "160000",
  });
});

test("(e) provider matching: claude, deepseek-orch, kimi match; codex, deepseek do not", () => {
  const s = mk({ providers: ["claude", "deepseek-orch", "kimi"] });
  for (const p of ["claude", "deepseek-orch", "kimi"]) assert.equal(providerMatches(s, p), true, p);
  for (const p of ["codex", "deepseek"]) assert.equal(providerMatches(s, p), false, p);
});

test("(f) enabled=false or handoffPct<=0 -> no turn action; sub-agents and non-completed turns skipped", () => {
  const agent = { provider: "claude" };
  assert.equal(turnEligible(mk(), agent, "completed"), true);
  assert.equal(turnEligible(mk({ enabled: false }), agent, "completed"), false);
  assert.equal(turnEligible(mk({ handoffPct: 0 }), agent, "completed"), false);
  assert.equal(turnEligible(mk({ handoffPct: -5 }), agent, "completed"), false);
  assert.equal(turnEligible(mk(), { ...agent, parentAgentId: "p" }, "completed"), false);
  assert.equal(turnEligible(mk(), agent, "failed"), false);
  assert.equal(providerMatches(mk({ enabled: false }), "claude"), false); // session_open also off
  assert.equal(ContextCompactSettingsSchema.safeParse({ handoffPct: -1 }).success, false);
});

test("(g) nudge text substitutes {pct}, {window}, {compact}; unknown tokens left; prefix added once", () => {
  const s = mk({ windowTokens: 160_000, handoffPrompt: "At {pct}% of {window}, compact {compact}%, {nope}" });
  assert.equal(buildNudgeText(s, 60), "[context-compact] At 60% of 160,000, compact 95%, {nope}");
  const already = mk({ handoffPrompt: "[context-compact] {pct}" });
  assert.equal(buildNudgeText(already, 7), "[context-compact] 7");
});

test("(g') nudge fires once: second candidate check with nudged flag is skipped; re-arms after drop", () => {
  const s = mk();
  assert.equal(verdictFor(100_000, s, false), "candidate");
  assert.equal(verdictFor(100_000, s, true), "skip");
  assert.equal(verdictFor(10_000, s, true), "rearm"); // after compaction the caller clears the flag
  assert.equal(isNudgeEcho("[context-compact] hi"), true);
  assert.equal(isNudgeEcho("hello"), false);
  assert.equal(isNudgeEcho(undefined), false);
});

test("handoffPct above compactPct never nudges (skip wins over candidate once pct>=compactPct)", () => {
  const s = mk({ handoffPct: 99, compactPct: 95 });
  assert.equal(verdictFor(155_000, s), "rearm"); // 97% < 99
  assert.equal(verdictFor(159_000, s), "skip");
});
