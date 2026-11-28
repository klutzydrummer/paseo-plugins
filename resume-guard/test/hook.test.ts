// Injection tests: drive contribute() with a fake server context and a fake Paseo SDK, exercising the
// real hook path (settings read -> snapshot read -> decision -> throw or allow). Run: npm test.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import contribute from "../index.server.ts";

const LIMIT_TEXT = "You've hit your 5-hour limit · resets 3pm";

type Snapshot = { status: string | null; lastUsage: { contextWindowUsedTokens?: number } | null };

function harness(over: {
  read?: () => Promise<unknown>;
  status?: string | null;
  lastUsage?: { contextWindowUsedTokens?: number } | null;
  refreshError?: boolean;
  reason?: string;
  timelineTexts?: string[];
  lastError?: string;
  timelineDelayMs?: number;
  timelineSpy?: { calls: number };
  evidenceTimeoutMs?: number;
  stateFile?: string;
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
        lastError: over.lastError,
        timeline: {
          refetch: async () => {
            if (over.timelineSpy) over.timelineSpy.calls++;
            if (over.timelineDelayMs) await new Promise((r) => setTimeout(r, over.timelineDelayMs));
            return { entries: (over.timelineTexts ?? []).map((text) => ({ item: { type: "assistant_message", text } })) };
          },
        },
      }),
    },
  };
  const stateFile = over.stateFile ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rg-test-")), "state.json");
  const off = contribute(server as never, stateFile, over.evidenceTimeoutMs);
  const hook = hooks.get("agent.open.before")!;
  const run = () => hook({ request: { agentId: "agent-abc123", reason: over.reason } }, { paseo });
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

// Rotation exemption: one allowed refresh of an errored agent with a limit notice, then blocked again.

const rotating = (extra: Parameters<typeof harness>[0] = {}) =>
  harness({ status: "error", lastUsage: { contextWindowUsedTokens: 86_000 }, reason: "refresh", timelineTexts: [LIMIT_TEXT], ...extra });

test("rotation: error + refresh + limit notice allowed once, second within the window denied", async () => {
  const h = rotating();
  assert.equal(await h.run(), undefined);
  await assert.rejects(h.run(), /may not be opened/);
});

test("rotation: allowedAt persists in the state file across plugin restarts", async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rg-test-")), "state.json");
  const a = rotating({ stateFile });
  assert.equal(await a.run(), undefined);
  const b = rotating({ stateFile });
  await assert.rejects(b.run(), /may not be opened/);
});

test("rotation: allowed again once the window has passed (0 minutes)", async () => {
  const h = rotating({ read: async () => ({ status: "ready", values: { thresholdTokens: 30_000, rotationExemptMinutes: 0 } }) });
  assert.equal(await h.run(), undefined);
  assert.equal(await h.run(), undefined);
});

test("rotation: error + resume with limit notice denied", async () => {
  await assert.rejects(rotating({ reason: "resume" }).run(), /may not be opened/);
});

test("rotation: error + refresh without limit evidence denied", async () => {
  await assert.rejects(rotating({ timelineTexts: ["ordinary crash"] }).run(), /may not be opened/);
});

test("rotation: non-error status still allowed", async () => {
  assert.equal(await rotating({ status: "idle" }).run(), undefined);
});

test("rotation: lastError limit notice allows without reading the timeline", async () => {
  const spy = { calls: 0 };
  const h = rotating({ timelineTexts: [], lastError: LIMIT_TEXT, timelineSpy: spy });
  assert.equal(await h.run(), undefined);
  assert.equal(spy.calls, 0);
});

test("rotation: slow timeline returns within budget and blocks", async () => {
  const h = rotating({ timelineDelayMs: 2_000, evidenceTimeoutMs: 50 });
  const started = Date.now();
  await assert.rejects(h.run(), /may not be opened/);
  assert.ok(Date.now() - started < 1_000);
});

test("rotation: fast timeline evidence still allows when lastError is absent", async () => {
  assert.equal(await rotating({ timelineDelayMs: 5, evidenceTimeoutMs: 500 }).run(), undefined);
});

test("rotation: non-limit lastError falls through and still blocks", async () => {
  await assert.rejects(rotating({ timelineTexts: [], lastError: "ordinary crash" }).run(), /may not be opened/);
});
