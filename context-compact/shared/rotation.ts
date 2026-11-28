// Pure rotation-seed logic (no Paseo imports). After a ZeroSub failover reload lands, the plugin /clears the agent
// in place and sends it a seed: its last stowed handoff plus a capped delta of the session transcript since the last
// /clear. Everything that touches the world (send, status, transcript, fs, clock) is injected so tests run with fakes.

import type { StowFs } from "./stow.ts";
import { isValidAgentId } from "./stow.ts";

export const SEED_CAP_CHARS = 40_000;
export const TOOL_RESULT_CAP = 500;
export const TOOL_INPUT_CAP = 300;
export const LOOP_GUARD_MS = 10 * 60 * 1000;
export const DELTA_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const HANDOFF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const READ_PIECE = "20k";

export interface DeltaResult {
  text: string;
  rows: number;
  /** True when a /clear marker row was found (delta starts after it); false = whole readable transcript. */
  markerFound: boolean;
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [+${s.length - n} chars cut]` : s);
const CLEAR_MARKER = "<command-name>/clear</command-name>";

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : "")).filter(Boolean).join("\n");
  return "";
}

/**
 * Build the delta from Claude session jsonl text: rows after the LAST /clear row, user and assistant text kept in full,
 * tool calls and results shortened (results to `toolResultCap` chars). Sidechain/meta rows and thinking are dropped.
 * `skipUserPrefix`: the first user row after the marker is dropped when it starts with this text (the injected handoff).
 */
export function buildDelta(jsonl: string, opts: { toolResultCap?: number; skipUserPrefix?: string } = {}): DeltaResult {
  const resultCap = opts.toolResultCap ?? TOOL_RESULT_CAP;
  const rows: any[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* a cut or corrupt line */
    }
  }
  let start = 0;
  let markerFound = false;
  rows.forEach((row, i) => {
    if (row?.type === "user" && !row.isSidechain && blockText(row.message?.content).includes(CLEAR_MARKER)) {
      start = i + 1;
      markerFound = true;
    }
  });
  const out: string[] = [];
  let skipped = false;
  const prefix = opts.skipUserPrefix?.trim();
  for (const row of rows.slice(start)) {
    if (row?.isSidechain || row?.isMeta) continue;
    const role = row?.type;
    if (role !== "user" && role !== "assistant") continue;
    const content = row.message?.content;
    const blocks: any[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        const t = b.text.trim();
        if (role === "user") {
          if (t.includes(CLEAR_MARKER) || t.startsWith("<local-command-")) continue;
          if (!skipped && prefix && t.startsWith(prefix)) {
            skipped = true;
            continue;
          }
          skipped = true;
        }
        out.push(`[${role}] ${t}`);
      } else if (b?.type === "tool_use") {
        out.push(`[tool_use ${String(b.name ?? "?")}] ${cap(JSON.stringify(b.input ?? {}), TOOL_INPUT_CAP)}`);
      } else if (b?.type === "tool_result") {
        const t = blockText(b.content).trim();
        out.push(`[tool_result] ${cap(t, resultCap)}`);
      }
    }
  }
  return { text: out.join("\n"), rows: out.length, markerFound };
}

export interface SeedInput {
  handoff: string | null;
  delta: DeltaResult;
  /** Where the full delta goes when the seed would pass the cap (written by the caller; path embedded in the seed). */
  deltaFile: string;
  capChars?: number;
}

export interface SeedResult {
  text: string;
  /** Set when the delta was too big: the caller must write `fullDelta` to `deltaFile`. */
  fullDelta?: string;
}

export function buildSeed(i: SeedInput): SeedResult {
  const limit = i.capChars ?? SEED_CAP_CHARS;
  const head =
    "[context-compact rotation-seed] Your account was switched after a usage limit and your context was cleared. " +
    "Resume the work from the material below; do not redo finished steps.\n\n" +
    (i.handoff
      ? `Last stowed handoff (its file, if it names one, is the source of truth and wins on any conflict):\n${i.handoff}\n`
      : "No handoff on record: you never stowed one, so the transcript delta is the only record of your recent work.\n") +
    "\n";
  const scope = i.delta.markerFound ? "since your last /clear" : "(no /clear marker found: the whole readable transcript)";
  const inline = `${head}Transcript delta ${scope} (${i.delta.rows} entries, tool results shortened):\n${i.delta.text}`;
  if (inline.length <= limit) return { text: inline };
  const pointer =
    `${head}The transcript delta ${scope} is ${i.delta.text.length} chars, too large to inline. It is in ${i.deltaFile}. ` +
    `Read it in ${READ_PIECE}-char pieces (not in one go), fold any facts missing from your handoff.md into it, then continue.`;
  return { text: pointer.slice(0, limit), fullDelta: i.delta.text };
}

export interface RotationDeps {
  sendClear(agentId: string): Promise<void>;
  sendText(agentId: string, text: string): Promise<void>;
  waitIdle(agentId: string): Promise<void>;
  /** Fresh agent status ("idle" | "running" | "error" | ...), or undefined when unreadable. */
  getStatus(agentId: string): Promise<string | undefined>;
  /** Raw Claude session jsonl for the agent, or null. */
  readTranscript(agentId: string): Promise<string | null>;
  sleep?(ms: number): Promise<void>;
}

export interface RotationFs extends StowFs {
  statSync(file: string): { mtimeMs: number };
}

export interface RotationOptions {
  /** Holds `pending/<id>.json`, `handoff/<id>.json` and `delta/<id>.md`. */
  dir: string;
  fs: RotationFs;
  now?: () => number;
  log?: (msg: string) => void;
  landingTimeoutMs?: number;
  landingPollMs?: number;
  capChars?: number;
}

export type RotationOutcome =
  | "seeded"
  | "skip:disabled"
  | "skip:non-claude"
  | "skip:inflight"
  | "skip:loop-guard"
  | "skip:busy"
  | "skip:not-landed"
  | "failed";

interface Pending {
  text: string;
  at: number;
  phase: "clear" | "seed";
}

export function createRotation(deps: RotationDeps, o: RotationOptions) {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pendingDir = `${o.dir}/pending`;
  const handoffDir = `${o.dir}/handoff`;
  const deltaDir = `${o.dir}/delta`;
  const inflight = new Set<string>();
  const lastSeedAt = new Map<string, number>();
  const unlink = (f: string) => {
    try {
      o.fs.unlinkSync(f);
    } catch {
      /* already gone */
    }
  };
  const writeJson = (dir: string, id: string, data: unknown) => {
    const file = `${dir}/${id}.json`;
    const tmp = `${dir}/${id}.tmp-${process.pid}-${now()}`;
    o.fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    o.fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    o.fs.renameSync(tmp, file);
  };
  const readJson = (dir: string, id: string): any | null => {
    try {
      return JSON.parse(o.fs.readFileSync(`${dir}/${id}.json`, "utf8"));
    } catch {
      return null;
    }
  };
  const names = (dir: string): string[] => {
    try {
      return o.fs.readdirSync(dir);
    } catch {
      return [];
    }
  };

  function purgeDeltas() {
    for (const n of names(deltaDir)) {
      try {
        if (now() - o.fs.statSync(`${deltaDir}/${n}`).mtimeMs > DELTA_MAX_AGE_MS) unlink(`${deltaDir}/${n}`);
      } catch {
        /* ignore */
      }
    }
  }

  async function deliver(agentId: string, p: Pending) {
    if (p.phase === "clear") {
      await deps.sendClear(agentId);
      await deps.waitIdle(agentId);
      p.phase = "seed";
      writeJson(pendingDir, agentId, p);
    }
    await deps.sendText(agentId, p.text);
    unlink(`${pendingDir}/${agentId}.json`);
  }

  return {
    /** Startup: drop stale files (pending 24 h, handoff 7 d, delta 24 h). Returns the number of pending seeds. */
    load(): number {
      purgeDeltas();
      for (const n of names(handoffDir)) {
        const id = n.slice(0, -5);
        const rec = readJson(handoffDir, id);
        if (!n.endsWith(".json") || typeof rec?.text !== "string" || now() - rec.at > HANDOFF_MAX_AGE_MS) unlink(`${handoffDir}/${n}`);
      }
      let pending = 0;
      for (const n of names(pendingDir)) {
        const id = n.slice(0, -5);
        const rec = readJson(pendingDir, id);
        if (!n.endsWith(".json") || !isValidAgentId(id) || typeof rec?.text !== "string" || now() - rec.at > DELTA_MAX_AGE_MS) {
          unlink(`${pendingDir}/${n}`);
          continue;
        }
        pending++;
      }
      return pending;
    },
    /** Remember the last stowed handoff text for an agent (survives delivery and restart). */
    recordHandoff(agentId: string, text: string) {
      if (!isValidAgentId(agentId) || text.trim() === "") return;
      try {
        writeJson(handoffDir, agentId, { text, at: now() });
      } catch (e) {
        log(`could not record handoff for ${agentId.slice(0, 8)}: ${(e as Error).message}`);
      }
    },
    lastHandoff(agentId: string): string | null {
      const rec = readJson(handoffDir, agentId);
      return typeof rec?.text === "string" && now() - rec.at <= HANDOFF_MAX_AGE_MS ? rec.text : null;
    },
    busy: (agentId: string) => inflight.has(agentId),
    pendingIds: () => names(pendingDir).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)),
    /** Finish seeds interrupted by a restart. Skips agents that are running. */
    async resumePending(): Promise<number> {
      let done = 0;
      for (const id of this.pendingIds()) {
        const p = readJson(pendingDir, id) as Pending | null;
        if (!p || inflight.has(id) || (await deps.getStatus(id)) === "running") continue;
        inflight.add(id);
        try {
          await deliver(id, p);
          done++;
        } catch (e) {
          log(`resume of pending seed for ${id.slice(0, 8)} failed: ${(e as Error).message}`);
        } finally {
          inflight.delete(id);
        }
      }
      return done;
    },
    /** The reload landed (or is about to): run clear -> seed once the agent is idle. */
    async onReloaded(agentId: string, info: { provider: string; enabled: boolean }): Promise<RotationOutcome> {
      if (!info.enabled) return "skip:disabled";
      if (info.provider !== "claude") return "skip:non-claude";
      if (!isValidAgentId(agentId)) return "failed";
      if (inflight.has(agentId)) return "skip:inflight";
      const last = lastSeedAt.get(agentId);
      if (last !== undefined && now() - last < LOOP_GUARD_MS) return "skip:loop-guard";
      inflight.add(agentId);
      try {
        // Landing = status leaves "error" and settles. "running" means a turn already started: never clear under it.
        const deadline = now() + (o.landingTimeoutMs ?? 120_000);
        let status: string | undefined;
        for (;;) {
          status = await deps.getStatus(agentId);
          if (status === "idle") break;
          if (status === "running") return "skip:busy";
          if (now() >= deadline) return "skip:not-landed";
          await sleep(o.landingPollMs ?? 500);
        }
        lastSeedAt.set(agentId, now());
        const handoff = this.lastHandoff(agentId);
        const jsonl = await deps.readTranscript(agentId);
        const delta = buildDelta(jsonl ?? "", { skipUserPrefix: handoff ?? undefined });
        const deltaFile = `${deltaDir}/${agentId}.md`;
        const seed = buildSeed({ handoff, delta, deltaFile, capChars: o.capChars });
        if (seed.fullDelta !== undefined) {
          o.fs.mkdirSync(deltaDir, { recursive: true, mode: 0o700 });
          o.fs.writeFileSync(deltaFile, seed.fullDelta, { mode: 0o600 });
          purgeDeltas();
        }
        const p: Pending = { text: seed.text, at: now(), phase: "clear" };
        writeJson(pendingDir, agentId, p); // before the /clear: a restart mid-sequence must not lose the seed
        await deliver(agentId, p);
        log(`${agentId.slice(0, 8)} rotation seed sent (${seed.text.length} chars${seed.fullDelta !== undefined ? ", delta in file" : ""})`);
        return "seeded";
      } catch (e) {
        log(`${agentId.slice(0, 8)} rotation seed failed: ${(e as Error).message}`);
        return "failed";
      } finally {
        inflight.delete(agentId);
      }
    },
  };
}
