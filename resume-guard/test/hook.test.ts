// Injection tests: drive contribute() with a fake server context and a fake Paseo SDK, exercising the
// real hook path (settings read -> snapshot read -> decision -> throw or allow). Run: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import contribute from "../index.server.ts";

type Snapshot = { status: string | null; lastUsage: { contextWindowUsedTokens?: number } | null };

function harness(over: {
  read?: () => Promise<unknown>;
  status?: string | null;
  lastUsage?: { contextWindowUsedTokens?: number } | null;
  refreshError?: boolean;
} = {}) {
  const hooks = new Map<string, (payload: any, context: any) => Promise<any>>();
  let removed = false;
  const read = over.read ?? (async () => ({ status: "ready", values: { thresholdTokens: 30_000 } }));
  const server = {
    registerSettings: () => ({ read }),
    addHook: (name: string, fn: any) => (hooks.set(name, fn), () => void (removed = true)),
  };
  const paseo = {
    agents: {
      ref: () => ({
        refresh: over.refreshError
          ? async () => {
              throw new Error("SDK unreachable");
            }
          : async () => undefined,
        status: over.status ?? null,
        lastUsage: over.lastUsage ?? null,
      }),
    },
  };
  const off = contribute(server as never);
  const hook = hooks.get("agent.open.before")!;
  const run = () => hook({ request: { agentId: "agent-abc123" } }, { paseo });
  return { run, hook, off: () => off(), assertRemoved: () => assert.equal(removed, true) };
}

test("registers agent.open.before and allows error + 10000 (under default threshold)", async () => {
  const h = harness({ status: "error", lastUsage: { contextWindowUsedTokens: 10_000 } });
  assert.equal(await h.run(), undefined);
});

test("blocks error + 60000 (over default threshold) with the deny message in the thrown error", async () => {
  const h = harness({ status: "error", lastUsage: { contextWindowUsedTokens: 60_000 } });
  await assert.rejects(h.run(), (error: Error) => {
    assert.ok(error.message.includes("agent-abc123"));
    assert.ok(error.message.includes("~60k"));
    assert.ok(error.message.includes("~30k"));
    assert.ok(error.message.includes("Do not resume it"));
    assert.ok(error.message.includes("<task>/workers/agent-abc123/handoff.md"));
    return true;
  });
});

test("allows running + 60000", async () => {
  const h = harness({ status: "running", lastUsage: { contextWindowUsedTokens: 60_000 } });
  assert.equal(await h.run(), undefined);
});

test("allows closed + 60000", async () => {
  const h = harness({ status: "closed", lastUsage: { contextWindowUsedTokens: 60_000 } });
  assert.equal(await h.run(), undefined);
});

test("allows idle and initializing + 60000", async () => {
  for (const status of ["idle", "initializing"]) {
    const h = harness({ status, lastUsage: { contextWindowUsedTokens: 60_000 } });
    assert.equal(await h.run(), undefined);
  }
});

test("settings unreadable: default 30000 applied, still blocks error + 60000", async () => {
  const h = harness({
    read: async () => {
      throw new Error("settings store unreachable");
    },
    status: "error",
    lastUsage: { contextWindowUsedTokens: 60_000 },
  });
  await assert.rejects(h.run(), /~30k/);
});

test("settings unreadable: default 30000 applied, error + 10000 still allowed", async () => {
  const h = harness({
    read: async () => {
      throw new Error("settings store unreachable");
    },
    status: "error",
    lastUsage: { contextWindowUsedTokens: 10_000 },
  });
  assert.equal(await h.run(), undefined);
});

test("non-ready settings state falls back to the default", async () => {
  const h = harness({
    read: async () => ({ status: "invalid", values: { thresholdTokens: 5000 } }),
    status: "error",
    lastUsage: { contextWindowUsedTokens: 60_000 },
  });
  await assert.rejects(h.run(), /~30k/);
});

test("custom threshold from settings applies (50000: 40000 allowed, 60000 blocked)", async () => {
  const allowed = harness({
    read: async () => ({ status: "ready", values: { thresholdTokens: 50_000 } }),
    status: "error",
    lastUsage: { contextWindowUsedTokens: 40_000 },
  });
  assert.equal(await allowed.run(), undefined);

  const blocked = harness({
    read: async () => ({ status: "ready", values: { thresholdTokens: 50_000 } }),
    status: "error",
    lastUsage: { contextWindowUsedTokens: 60_000 },
  });
  await assert.rejects(blocked.run(), /~50k/);
});

test("snapshot unreadable: fails open (allows the open)", async () => {
  const h = harness({ refreshError: true });
  assert.equal(await h.run(), undefined);
});

test("cleanup removes the hook", () => {
  const h = harness();
  h.off();
  h.assertRemoved();
});
