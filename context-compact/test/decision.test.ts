// Dry-run tests for the nudge/compact decision logic. Run: npm test  (node --test, no Paseo involved).
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNudgeText,
  classifyPct,
  contextPct,
  isNudgeEcho,
  type NudgeLevel,
  providerMatches,
  turnEligible,
} from "../shared/decision.ts";
import { ContextCompactSettingsSchema, DEFAULT_SETTINGS, compactEnv, type ContextCompactSettings } from "../shared/settings.ts";

// Settings built directly (bypassing the schema) so windows below the schema minimum can be exercised.
const mk = (over: Partial<ContextCompactSettings> = {}): ContextCompactSettings => ({
  ...ContextCompactSettingsSchema.parse({}),
  handoffPct: 50,
  compactPct: 95,
  windowTokens: 160_000,
  ...over,
});

/** What turn_ended does after the token count is known (nudge state kept by the caller). */
const verdictFor = (tokens: number, s: ContextCompactSettings, level: NudgeLevel = 0) =>
  classifyPct(contextPct(tokens, s.windowTokens), s, level);

test("(a) 12k tokens, window 20000: nudge fires (60% >= 50%), compact not reached", () => {
  const s = mk({ windowTokens: 20_000 });
  assert.equal(contextPct(12_000, s.windowTokens), 60);
  assert.equal(verdictFor(12_000, s), "soft");
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
  assert.equal(verdictFor(80_000, s), "soft");
  assert.equal(verdictFor(79_199, s), "rearm"); // 49.499 -> 49
  assert.equal(verdictFor(79_200, s), "soft"); // 49.5 -> 50 (Math.round)
});

test("(d) ~152k at 160000: compact threshold 95% -> nudge suppressed; env carries 95 / 160000", () => {
  const s = mk();
  assert.equal(verdictFor(152_000, s), "skip");
  assert.equal(verdictFor(151_199, s), "hard"); // 94.499 -> 94 (past hardHandoffPct)
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
  assert.equal(verdictFor(100_000, s, 0), "soft");
  assert.equal(verdictFor(100_000, s, 1), "skip");
  assert.equal(verdictFor(10_000, s, 1), "rearm"); // after compaction the caller clears the flag
  assert.equal(isNudgeEcho("[context-compact] hi"), true);
  assert.equal(isNudgeEcho("hello"), false);
  assert.equal(isNudgeEcho(undefined), false);
});

test("handoffPct above compactPct never nudges (skip wins over candidate once pct>=compactPct)", () => {
  const s = mk({ handoffPct: 99, compactPct: 95 });
  assert.equal(verdictFor(155_000, s), "rearm"); // 97% < 99
  assert.equal(verdictFor(159_000, s), "skip");
});

test("default nudge text tells the agent to self-initiate handoff via stow_handoff", () => {
  const t = buildNudgeText(mk({ handoffPrompt: DEFAULT_SETTINGS.handoffPrompt }), 50);
  assert.ok(t.startsWith("[context-compact] "));
  for (const frag of ["without asking the user", "state file", "handoff file", "stow_handoff(", "source of truth", "wins on any conflict", "end your turn", "report its path"])
    assert.ok(t.includes(frag), frag);
});

// ---- two-step nudge (soft at handoffPct, hard at hardHandoffPct) ----
const W = 160_000; // 50% = 80k, 75% = 120k
const tok = (pct: number) => (pct * W) / 100;

/** Simulates turn_ended over a token series with the same state handling as index.server.ts. */
function run(series: number[], s = mk()) {
  let level: NudgeLevel = 0;
  const sent: string[] = [];
  for (const t of series) {
    const v = classifyPct(contextPct(t, s.windowTokens), s, level);
    if (v === "rearm") level = 0;
    else if (v === "soft" || v === "hard") {
      level = v === "hard" ? 2 : 1;
      sent.push(v);
    }
  }
  return sent;
}

test("defaults: handoffPct 50, hardHandoffPct 75, compactPct unchanged", () => {
  const d = ContextCompactSettingsSchema.parse({});
  assert.equal(d.handoffPct, 50);
  assert.equal(d.hardHandoffPct, 75);
  assert.equal(d.compactPct, 60);
  assert.equal(d.nudgeLabelKey, "studio.role");
  assert.equal(d.nudgeLabelValue, "mm");
  // an old saved config without the new keys still parses
  assert.equal(ContextCompactSettingsSchema.safeParse({ handoffPct: 50, windowTokens: 160_000 }).success, true);
});

test("neither nudge below 50%", () => {
  assert.deepEqual(run([tok(10), tok(30), tok(49)]), []);
});

test("soft fires once at 50%, then stays quiet until 75%", () => {
  assert.deepEqual(run([tok(50), tok(55), tok(60), tok(74)]), ["soft"]);
});

test("hard fires once at 75% after soft; jumping straight past 75% sends only hard", () => {
  assert.deepEqual(run([tok(50), tok(75), tok(80), tok(90)]), ["soft", "hard"]);
  assert.deepEqual(run([tok(20), tok(80), tok(85)]), ["hard"]);
});

test("nothing at/over compactPct", () => {
  assert.deepEqual(run([tok(95), tok(99)]), []);
});

test("re-arm after compaction: both fire again", () => {
  assert.deepEqual(run([tok(50), tok(75), tok(10), tok(52), tok(76)]), ["soft", "hard", "soft", "hard"]);
});

test("hardHandoffPct 0 disables the hard nudge", () => {
  assert.deepEqual(run([tok(50), tok(80)], mk({ hardHandoffPct: 0 })), ["soft"]);
});

test("soft and hard text differ; hard says hand off now, soft says finish the step", () => {
  const s = mk();
  const soft = buildNudgeText(s, 50, "soft");
  const hard = buildNudgeText(s, 75, "hard");
  assert.ok(soft.includes("Finish the current step") && soft.includes("start no new phase") && soft.includes("next clean stopping point"));
  assert.ok(hard.includes("Hand off now"));
  assert.ok(!hard.includes("Finish the current step"));
  assert.ok(hard.includes("75%") && hard.startsWith("[context-compact] "));
});

// ---- child-agent opt-in label ----
test("labelled child (studio.role=mm) is eligible; unlabelled child and wrong value are not", () => {
  const base = { provider: "claude", parentAgentId: "p" };
  assert.equal(turnEligible(mk(), { ...base, labels: { "studio.role": "mm" } }, "completed"), true);
  assert.equal(turnEligible(mk(), { ...base }, "completed"), false);
  assert.equal(turnEligible(mk(), { ...base, labels: {} }, "completed"), false);
  assert.equal(turnEligible(mk(), { ...base, labels: { "studio.role": "worker" } }, "completed"), false);
  assert.equal(turnEligible(mk(), { ...base, labels: { "studio.role": "mm" } }, "failed"), false);
});

test("top level unchanged: eligible with or without labels", () => {
  assert.equal(turnEligible(mk(), { provider: "claude" }, "completed"), true);
  assert.equal(turnEligible(mk(), { provider: "claude", labels: { foo: "bar" } }, "completed"), true);
  assert.equal(turnEligible(mk(), { provider: "claude", parentAgentId: null }, "completed"), true);
});

test("label key/value are settings; empty key disables the child opt-in", () => {
  const child = { provider: "claude", parentAgentId: "p", labels: { role: "lead" } };
  assert.equal(turnEligible(mk({ nudgeLabelKey: "role", nudgeLabelValue: "lead" }), child, "completed"), true);
  assert.equal(turnEligible(mk({ nudgeLabelKey: "" }), child, "completed"), false);
});
