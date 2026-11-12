import { test } from "node:test";
import assert from "node:assert/strict";
import { createLabelStore } from "../shared/labels.ts";
import { turnEligible } from "../shared/decision.ts";

const s = { enabled: true, handoffPct: 50, providers: ["claude"], nudgeLabelKey: "studio.role", nudgeLabelValue: "mm" };
const child = { id: "c1", provider: "claude", parentAgentId: "p" };

test("labelled child is nudged via recorded labels", () => {
  const st = createLabelStore();
  st.record("c1", { "studio.role": "mm" });
  assert.equal(turnEligible(s, st.withLabels(child), "completed"), true);
});

test("child with no record, or other label, is not nudged", () => {
  const st = createLabelStore();
  assert.equal(turnEligible(s, st.withLabels(child), "completed"), false);
  st.record("c1", { "studio.role": "worker" });
  assert.equal(turnEligible(s, st.withLabels(child), "completed"), false);
});

test("re-open overwrites, missing labels clear, forget drops", () => {
  const st = createLabelStore();
  st.record("c1", { "studio.role": "mm" });
  st.record("c1", undefined);
  assert.equal(turnEligible(s, st.withLabels(child), "completed"), false);
  st.record("c1", { "studio.role": "mm" });
  st.forget("c1");
  assert.equal(turnEligible(s, st.withLabels(child), "completed"), false);
});

test("top level agent unaffected", () => {
  assert.equal(turnEligible(s, createLabelStore().withLabels({ id: "t", provider: "claude" }), "completed"), true);
});
