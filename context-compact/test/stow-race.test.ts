import { test } from "node:test";
import assert from "node:assert/strict";
import fsReal from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

// Drives the real plugin entry (index.server.ts) with a fake Paseo server. The SDK packages are devDependencies that
// may not be installed; when a bare import fails to resolve, a permissive stub stands in (the handler under test
// uses only defineAgentTool, and the settings schema is never evaluated because the fake serves the settings).
const stub = (): any => new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : stub()), apply: () => stub() });
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && !path.extname(specifier)) return next(`${specifier}.ts`, context);
      if (!specifier.startsWith(".") && !specifier.startsWith("node:")) return { url: `stub:${specifier}`, shortCircuit: true };
      throw e;
    }
  },
  load(url, context, next) {
    if (url.startsWith("stub:")) {
      return {
        format: "module",
        shortCircuit: true,
        source:
          "const s = globalThis.__ccStub; export const defineAgentTool = (t) => t; export const defineSettings = (t) => t; export const z = s; export default s;",
      };
    }
    return next(url, context);
  },
});
(globalThis as any).__ccStub = stub();

const ID = "0a1b2c3d-1111-2222-3333-444455556666";
const SESSION = "sess-1";

test("stow delivery: the /clear's turn_ended triggers no nudge, the text is delivered, nudge state re-arms", async () => {
  const home = fsReal.mkdtempSync(path.join(os.tmpdir(), "cc-race-"));
  process.env.HOME = home;
  process.env.PASEO_HOME = path.join(home, ".paseo");
  process.env.XDG_STATE_HOME = path.join(home, "state");

  // Stale pre-clear transcript: 800k of a 1M window = 80% -> a "hard" nudge if it were checked.
  fsReal.mkdirSync(path.join(process.env.PASEO_HOME, "agents", "proj"), { recursive: true });
  fsReal.writeFileSync(
    path.join(process.env.PASEO_HOME, "agents", "proj", `${ID}.json`),
    JSON.stringify({ persistence: { sessionId: SESSION } }),
  );
  fsReal.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
  fsReal.writeFileSync(
    path.join(home, ".claude", "projects", "p", `${SESSION}.jsonl`),
    JSON.stringify({ message: { usage: { input_tokens: 1, cache_read_input_tokens: 800_000 } } }) + "\n",
  );

  const settings = {
    enabled: true,
    providers: ["claude"],
    compactPct: 90,
    windowTokens: 1_000_000,
    handoffPct: 50,
    hardHandoffPct: 75,
    nudgeLabelKey: "studio.role",
    nudgeLabelValue: "mm",
    handoffPrompt: "soft {pct}",
    hardHandoffPrompt: "hard {pct}",
  };

  const sent: string[] = [];
  let releaseClear!: () => void;
  const clearGate = new Promise<void>((r) => (releaseClear = r));
  const ref = {
    status: "idle",
    refresh: async () => {},
    send: async (text: string) => {
      sent.push(text);
      if (text === "/clear") await clearGate; // keep the delivery in flight while the clear's turn_ended fires
    },
    timeline: { refetch: async () => ({ entries: [] }) },
  };
  const paseo = { agents: { ref: () => ref } };

  const hooks: Record<string, (e: any, ctx: any) => Promise<any>> = {};
  let tool: any;
  const server: any = {
    registerSettings: () => ({ read: async () => ({ status: "ready", values: settings }) }),
    addHook: (name: string, fn: any) => ((hooks[name] = fn), () => {}),
    on: (name: string, fn: any) => ((hooks[name] = fn), () => {}),
    before: (name: string, fn: any) => ((hooks[name] = fn), () => {}),
  };

  const { default: contribute } = await import(pathToFileURL(path.resolve(import.meta.dirname, "../index.server.ts")).href);
  contribute(server);

  // The agent stows a handoff (the tool is the one handed to agent.open.before).
  const opened = await hooks["agent.open.before"]({ request: { agentId: ID, labels: null, provider: "claude", purpose: "interactive", tools: [] } }, {});
  tool = opened.tools[0];
  const r = tool.execute({ text: "handoff-note" }, { agent: { id: ID }, paseo });
  assert.equal(r.isError, false);

  const event = { agent: { id: ID, provider: "claude" }, outcome: { kind: "completed" }, timeline: [{ type: "assistant_message" }] };
  await hooks["agent.turn_ended"](event, { paseo }); // starts the detached delivery: sends /clear (blocked)
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, ["/clear"]);

  // /clear's own turn end while the transcript is still the stale one.
  await hooks["agent.turn_ended"](event, { paseo });
  assert.deepEqual(sent, ["/clear"], "no nudge may be sent during stow delivery");

  // Let the delivery finish: waitIdle (settle 1 s + two idle reads) then the handoff text.
  releaseClear();
  const deadline = Date.now() + 10_000;
  while (!sent.includes("handoff-note") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sent, ["/clear", "handoff-note"]);

  // Delivery succeeded -> nudge state is cleared, and delivery is no longer in flight: a normal turn end nudges again.
  await new Promise((r) => setTimeout(r, 20));
  await hooks["agent.turn_ended"](event, { paseo });
  assert.equal(sent.length, 3);
  assert.match(sent[2], /hard 80/);
});
