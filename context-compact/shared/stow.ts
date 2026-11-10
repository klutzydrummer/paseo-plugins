// Pure stow/handoff logic (no Paseo imports). The plugin wires `stow` to an agent tool and `onTurnEnded` to
// the agent.turn_ended hook; `send` and `waitIdle` are injected so tests run with a fake.

export interface StowDeps {
  /** Send a prompt to the agent. For `/clear` this must reach Claude WITHOUT Paseo's caller-identity header. */
  sendClear(agentId: string): Promise<void>;
  sendText(agentId: string, text: string): Promise<void>;
  /** Resolve when the agent is idle again (after /clear). Reject/throw on timeout. */
  waitIdle(agentId: string): Promise<void>;
}

/** Minimal sync fs surface, injectable for tests. `node:fs` satisfies it. */
export interface StowFs {
  mkdirSync(dir: string, opts: { recursive: boolean; mode: number }): unknown;
  writeFileSync(file: string, data: string, opts: { mode: number }): unknown;
  renameSync(from: string, to: string): unknown;
  readFileSync(file: string, enc: "utf8"): string;
  readdirSync(dir: string): string[];
  unlinkSync(file: string): unknown;
}

export interface StowStoreOptions {
  /** Directory holding one `<agentId>.json` per pending note (created 0700). */
  dir: string;
  fs: StowFs;
  /** Notes older than this are dropped at load and at turn end. */
  maxAgeMs: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Notes older than this are dropped (24 h: long enough to survive a restart/outage, short enough not to resurface weeks later). */
export const STOW_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// uuid-ish: hex and dashes only, so an id can never carry a path separator or `..`.
const ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;
export const isValidAgentId = (id: unknown): id is string => typeof id === "string" && ID_RE.test(id);

export const STOW_ACK = "Handoff stowed. End your turn now; your context will be cleared and the text sent back to you.";

export function createStow(deps: StowDeps, store?: StowStoreOptions) {
  const stowed = new Map<string, string>();
  const now = store?.now ?? Date.now;
  const log = store?.log ?? (() => {});
  const fileOf = (id: string) => `${store!.dir}/${id}.json`;
  const unlink = (id: string) => {
    try {
      store!.fs.unlinkSync(fileOf(id));
    } catch {
      /* already gone */
    }
  };
  const stale = (stowedAt: number) => now() - stowedAt > store!.maxAgeMs;
  const stowedAtOf = new Map<string, number>();

  return {
    /** Load persisted notes into memory (call once at plugin startup). Stale and corrupt files are deleted. */
    load(): number {
      if (!store) return 0;
      let names: string[];
      try {
        names = store.fs.readdirSync(store.dir);
      } catch {
        return 0; // no dir yet
      }
      let loaded = 0;
      for (const name of names) {
        const id = name.endsWith(".json") ? name.slice(0, -5) : "";
        if (!isValidAgentId(id)) {
          if (name.includes(".tmp-")) {
            try { store.fs.unlinkSync(`${store.dir}/${name}`); } catch { /* ignore */ }
          }
          continue;
        }
        try {
          const rec = JSON.parse(store.fs.readFileSync(fileOf(id), "utf8"));
          if (typeof rec?.text !== "string" || rec.text.trim() === "" || typeof rec?.stowedAt !== "number") throw new Error("bad shape");
          if (stale(rec.stowedAt)) {
            log(`dropped stale stowed note for ${id.slice(0, 8)}`);
            unlink(id);
            continue;
          }
          stowed.set(id, rec.text);
          stowedAtOf.set(id, rec.stowedAt);
          loaded++;
        } catch (e) {
          log(`dropped unreadable stowed note ${name}: ${(e as Error).message}`);
          unlink(id);
        }
      }
      return loaded;
    },
    /** Store text for the CALLING agent (id comes from the tool-call context). Replaces an earlier call. */
    stow(agentId: string, text: string): { ok: boolean; message: string } {
      if (typeof text !== "string" || text.trim() === "") return { ok: false, message: "stow_handoff: text must not be empty." };
      if (store) {
        if (!isValidAgentId(agentId)) return { ok: false, message: "stow_handoff: invalid agent id." };
        const at = now();
        const tmp = `${store.dir}/${agentId}.tmp-${process.pid}-${at}`;
        try {
          store.fs.mkdirSync(store.dir, { recursive: true, mode: 0o700 });
          store.fs.writeFileSync(tmp, JSON.stringify({ text, stowedAt: at }), { mode: 0o600 });
          store.fs.renameSync(tmp, fileOf(agentId));
        } catch (e) {
          try { store.fs.unlinkSync(tmp); } catch { /* ignore */ }
          return { ok: false, message: `stow_handoff: could not persist note: ${(e as Error).message}` };
        }
        stowedAtOf.set(agentId, at);
      }
      stowed.set(agentId, text);
      return { ok: true, message: STOW_ACK };
    },
    has: (agentId: string) => stowed.has(agentId),
    /** Returns true if a handoff was performed. */
    async onTurnEnded(agentId: string, outcomeKind: string): Promise<boolean> {
      if (outcomeKind !== "completed") return false;
      const text = stowed.get(agentId);
      if (text === undefined) return false;
      stowed.delete(agentId); // one-shot: removed BEFORE any send
      const at = stowedAtOf.get(agentId);
      stowedAtOf.delete(agentId);
      if (store) {
        unlink(agentId);
        if (at !== undefined && stale(at)) {
          log(`dropped stale stowed note for ${agentId.slice(0, 8)}`);
          return false;
        }
      }
      await deps.sendClear(agentId);
      await deps.waitIdle(agentId);
      await deps.sendText(agentId, text);
      return true;
    },
  };
}
