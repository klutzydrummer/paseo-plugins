import { test } from "node:test";
import assert from "node:assert/strict";
import contribute from "../index.server.ts";

test("registers agent.create.before and rewrites default", async () => {
  const hooks = new Map<string, (p: any) => Promise<any>>();
  let removed = false;
  const off = contribute({
    addHook: (name: string, fn: any) => (hooks.set(name, fn), () => void (removed = true)),
  } as never);
  const h = hooks.get("agent.create.before")!;
  const out = await h({ request: { config: { provider: "claude", modeId: "default" }, metadata: {} } });
  assert.equal(out.config.modeId, "auto");
  assert.equal(await h({ request: { config: { provider: "claude", modeId: "plan" }, metadata: {} } }), undefined);
  (off as () => void)();
  assert.equal(removed, true);
});
