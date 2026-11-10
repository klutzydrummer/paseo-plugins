import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStow } from "./shared/stow";
import { compactEnv, contextCompactSettings, type ContextCompactSettings } from "./shared/settings";
import { buildNudgeText, classifyPct, contextPct, isNudgeEcho, providerMatches, turnEligible } from "./shared/decision";

// context-compact — Claude Code auto-compaction threshold for every Claude session Paseo opens, plus an optional
// "update your notes before compaction" nudge.
//
// Two jobs:
//  1. `before("agent.session_open")` — every Claude session Paseo opens (create, resume, refresh, import) gets
//     CLAUDE_AUTOCOMPACT_PCT_OVERRIDE + CLAUDE_CODE_AUTO_COMPACT_WINDOW, so Claude Code compacts in the same chat at
//     compactPct % of windowTokens. Claude Code does the compaction and carries on; nothing is restarted.
//  2. `on("agent.turn_ended")` — reads the context size of the session's LAST API call from its transcript
//     (~/.claude/projects/*/<sessionId>.jsonl, the same source cache-meter reads) and, once it passes handoffPct,
//     sends the agent one prompt asking it to update its durable state before compaction. Re-armed when the
//     context falls back under handoffPct (i.e. after a compaction). Top-level agents only: a sub-agent's state
//     belongs to its parent.
//
// What it cannot see: a Claude Code chat started outside Paseo (a plain terminal `claude`) never passes through
// session_open — that one is governed by ~/.claude/settings.json `env` alone. And a `env` entry for the same
// variable in ~/.claude/settings.json is applied by Claude Code AFTER launch, overriding this plugin; keep the
// variables out of settings.json while this plugin is the source.

const HOME = os.homedir();
const AGENTS_DIR = path.join(process.env.PASEO_HOME || path.join(HOME, ".paseo"), "agents");
const CLAUDE_PROJECTS = path.join(HOME, ".claude", "projects");
const TAIL_BYTES = 512 * 1024;
const FLUSH_RETRY_MS = 1500;

async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

async function transcriptFor(agentId: string): Promise<string | null> {
  for (const projectDir of await listFiles(AGENTS_DIR)) {
    let rec: any;
    try {
      rec = JSON.parse(await fs.readFile(path.join(projectDir, `${agentId}.json`), "utf8"));
    } catch {
      continue;
    }
    const p = rec?.persistence ?? {};
    const sid: string | undefined = p.sessionId ?? rec?.runtimeInfo?.sessionId ?? p.nativeHandle;
    if (!sid) return null;
    for (const dir of await listFiles(CLAUDE_PROJECTS)) {
      const f = path.join(dir, `${sid}.jsonl`);
      try {
        await fs.stat(f);
        return f;
      } catch {
        /* next */
      }
    }
    return null;
  }
  return null;
}

/** Context tokens of the last API call in the transcript tail (input + cache read + cache write), or null. */
export async function lastContextTokens(file: string): Promise<number | null> {
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('"usage"')) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // the first line of the tail is usually cut
      }
      if (row?.isSidechain) continue;
      const u = row?.message?.usage;
      if (!u || typeof u !== "object") continue;
      const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (total > 0) return total;
    }
    return null;
  } finally {
    await fh.close();
  }
}

// Paseo 0.13.0 (#7477) sends agent.turn_ended with an empty `timeline`; fetch the tail when it is empty.
async function turnTimeline<T>(paseo: any, agentId: string, given: readonly T[], limit: number): Promise<readonly T[]> {
  if (given.length > 0) return given;
  const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit, projection: "canonical" });
  return page.entries.map((entry: { item: T }) => entry.item);
}

const IDLE_POLL_MS = 500;
const IDLE_SETTLE_MS = 1000;
const IDLE_TIMEOUT_MS = 60_000;

// After `/clear` the agent may flip running -> idle, or (a local command) never visibly leave idle. Wait a short
// settle period, then require two consecutive idle reads.
async function waitIdle(paseo: any, agentId: string): Promise<void> {
  const ref = paseo.agents.ref(agentId);
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  await new Promise((r) => setTimeout(r, IDLE_SETTLE_MS));
  let idleReads = 0;
  while (Date.now() < deadline) {
    await ref.refresh();
    idleReads = ref.status === "idle" ? idleReads + 1 : 0;
    if (idleReads >= 2) return;
    await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
  }
  throw new Error("agent did not become idle after /clear");
}

export default function contribute(server: PluginServerContext) {
  const settingsHandle = server.registerSettings(contextCompactSettings);
  const nudged = new Set<string>();

  async function current(): Promise<ContextCompactSettings | null> {
    try {
      const s = await settingsHandle.read();
      return s.status === "ready" && s.values ? s.values : null;
    } catch {
      return null;
    }
  }

  // stow_handoff: the plugin sends through `paseo.agents.ref(id).send`, which passes no `sourceAgentId`, so Paseo
  // records no agent provenance and `/clear` reaches Claude as a command (see README).
  let sdk: any = null;
  const stow = createStow({
    sendClear: (id) => sdk.agents.ref(id).send("/clear"),
    waitIdle: (id) => waitIdle(sdk, id),
    sendText: (id, text) => sdk.agents.ref(id).send(text),
  });
  const stowHandoff = defineAgentTool({
    name: "stow_handoff",
    title: "Stow handoff",
    description:
      "Stow a handoff note, then end your turn. When your turn ends, Paseo clears your context (/clear) and sends the note back to you as your next prompt. Calling it again replaces the earlier note.",
    input: z.object({ text: z.string().describe("The handoff text to receive after the context is cleared") }),
    execute({ text }, { agent, paseo }) {
      sdk = paseo;
      const r = stow.stow(agent.id, text);
      return { text: r.message, isError: !r.ok };
    },
  });

  const removeTools = server.addHook("agent.open.before", async ({ request }) => {
    const s = await current();
    if (!s || !s.enabled || !s.providers.includes(request.provider)) return undefined;
    if (request.purpose !== "interactive") return undefined;
    return { ...request, tools: [...request.tools, stowHandoff] };
  });

  const removeOpen = server.before("agent.session_open", async ({ request }) => {
    const s = await current();
    if (!s || !providerMatches(s, request.provider)) return undefined;
    if (request.purpose !== "interactive") return undefined;
    const env = compactEnv(s);
    console.log(
      `[context-compact] ${request.agentId.slice(0, 8)} ${request.provider} ${request.reason}: compact at ${s.compactPct}% of ${s.windowTokens}`,
    );
    return { ...request, env: { ...request.env, ...env } };
  });

  const removeTurn = server.on("agent.turn_ended", async (event, { paseo }) => {
    const { agent, outcome } = event;
    sdk = paseo;
    // Hooks have a 30 s timeout; run the clear -> idle -> text sequence detached. The entry is deleted
    // synchronously, so a second turn_ended cannot repeat it.
    if (stow.has(agent.id) && outcome.kind === "completed") {
      stow.onTurnEnded(agent.id, outcome.kind).catch((error) =>
        console.error(`[context-compact] ${agent.id.slice(0, 8)} stow handoff failed:`, (error as Error)?.message ?? error),
      );
      return;
    }
    try {
      const s = await current();
      if (!s || !turnEligible(s, agent, outcome.kind)) return;

      const file = await transcriptFor(agent.id);
      if (!file) return;
      let tokens = await lastContextTokens(file);
      if (tokens === null) {
        await new Promise((r) => setTimeout(r, FLUSH_RETRY_MS));
        tokens = await lastContextTokens(file);
      }
      if (tokens === null) return;
      const pct = contextPct(tokens, s.windowTokens);

      const verdict = classifyPct(pct, s, nudged.has(agent.id));
      if (verdict === "rearm") {
        nudged.delete(agent.id); // compacted (or never got there): re-arm
        return;
      }
      if (verdict === "skip") return;
      // The nudge's own turn ends here too; it is covered by `nudged`, but never answer a nudge with a nudge.
      const timeline = await turnTimeline(paseo, agent.id, event.timeline, 50);
      const lastPrompt = [...timeline].reverse().find((item) => item.type === "user_message") as { text?: string } | undefined;
      if (isNudgeEcho(lastPrompt?.text)) return;

      nudged.add(agent.id);
      await paseo.agents.ref(agent.id).send(buildNudgeText(s, pct));
      console.log(`[context-compact] ${agent.id.slice(0, 8)} at ${pct}% (${tokens} tokens): handoff nudge sent`);
    } catch (error) {
      console.error(`[context-compact] ${agent.id.slice(0, 8)} turn_ended failed:`, (error as Error)?.message ?? error);
    }
  });

  return () => {
    removeOpen();
    removeTools();
    removeTurn();
  };
}
