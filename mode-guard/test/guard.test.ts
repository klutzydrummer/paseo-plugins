import { test } from "node:test";
import assert from "node:assert/strict";
import { guardMode, GUARDED_PROVIDERS } from "../shared/guard.ts";

const req = (config: Record<string, unknown>) => ({ config, env: { A: "1" }, metadata: { m: 1 } });

test("default -> auto, other fields preserved", () => {
  const input = req({ provider: "claude", modeId: "default", title: "t", model: "x", cwd: "/w" });
  const { request, rewritten } = guardMode(input);
  assert.equal(rewritten, true);
  assert.deepEqual(request.config, { provider: "claude", modeId: "auto", title: "t", model: "x", cwd: "/w" });
  assert.deepEqual(request.env, { A: "1" });
  assert.deepEqual(request.metadata, { m: 1 });
});

test("input is not mutated", () => {
  const input = req({ provider: "claude", modeId: "default" });
  guardMode(input);
  assert.equal(input.config.modeId, "default");
});

for (const mode of ["auto", "plan", "acceptEdits", "bypassPermissions", "weird"]) {
  test(`${mode} untouched`, () => {
    const input = req({ provider: "claude", modeId: mode });
    const out = guardMode(input);
    assert.equal(out.rewritten, false);
    assert.equal(out.request, input);
  });
}

test("undefined modeId untouched", () => {
  const input = req({ provider: "claude" });
  const out = guardMode(input);
  assert.equal(out.rewritten, false);
  assert.equal(out.request, input);
});

test("other or missing provider untouched", () => {
  for (const config of [{ provider: "opencode", modeId: "default" }, { modeId: "default" }]) {
    const input = req(config);
    const out = guardMode(input);
    assert.equal(out.rewritten, false);
    assert.equal(out.request.config.modeId, "default");
  }
});

test("every guarded provider is rewritten", () => {
  for (const provider of GUARDED_PROVIDERS) assert.equal(guardMode(req({ provider, modeId: "default" })).rewritten, true);
});

test("request without config is returned unchanged", () => {
  const input = {} as { config?: undefined };
  assert.equal(guardMode(input).request, input);
});
