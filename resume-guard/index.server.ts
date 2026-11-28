import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  buildDenyMessage,
  hasLimitEvidence,
  logLine,
  approxK,
  resolveRotationMinutes,
  resolveThreshold,
  rotationLogLine,
  shouldAllowRotation,
  shouldBlockResume,
  type ResumeSnapshot,
} from "./shared/decision.ts";
import { DEFAULT_ROTATION_EXEMPT_MINUTES, DEFAULT_THRESHOLD_TOKENS, resumeGuardSettings } from "./shared/settings.ts";

// resume-guard: one agent.open.before hook. An open (create, resume, refresh, import) is blocked when the agent
// snapshot has status "error" and its recorded context usage is above the threshold, because resuming such an
// agent would pay for its whole context again. The deny message tells the sender to write a handoff file and
// spawn a fresh agent instead.
//
// Rotation exemption: ZeroSub reloads (reason "refresh") an agent that hit an account limit, and that agent is in
// status "error". One such refresh per agent is allowed when its recent timeline carries a CLI limit notice, then
// blocked again for rotationExemptMinutes. Evidence is the agent lastError, else a bounded (5 s) timeline tail, not a ZeroSub RPC: the plugin SDK has no
// documented plugin-to-plugin call. allowedAt is kept in memory and in a small state file so a daemon restart
// does not grant a second exemption.
//
// Known limit: a throw from agent.open.before surfaces to the client as the generic
// "Plugin resume-guard agent.open.before failed: <message>" failure text, not a custom deny message. The whole
// reason lives in the thrown error text for that reason.
const STATE_FILE = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
  "paseo-plugins",
  "resume-guard",
  "rotation-allowed.json",
);
const EVIDENCE_TIMELINE_ITEMS = 20;
// The hook RPC times out at 30 s, so the timeline read is capped well below that.
const EVIDENCE_TIMELINE_TIMEOUT_MS = 5_000;

function loadAllowedAt(file: string): Map<string, number> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return new Map(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number"));
  } catch {
    return new Map();
  }
}

function saveAllowedAt(file: string, map: Map<string, number>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(map)));
  } catch (error) {
    console.error("[resume-guard] saving rotation state failed:", (error as Error)?.message ?? error);
  }
}

/**
 * Limit evidence for an errored agent. The agent's lastError (already on the ref after refresh) is checked first;
 * only when it carries no limit notice is the timeline tail read, bounded by a timeout. A slow or unreadable
 * timeline yields no evidence, so the open stays blocked as an ordinary resume (fail closed).
 */
async function limitEvidence(ref: any, agentId: string, timeoutMs: number = EVIDENCE_TIMELINE_TIMEOUT_MS): Promise<boolean> {
  if (typeof ref.lastError === "string" && hasLimitEvidence([ref.lastError])) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = ref.timeline.refetch({ direction: "tail", limit: EVIDENCE_TIMELINE_ITEMS, projection: "canonical" });
    read.catch(() => undefined); // a read that loses the race must not become an unhandled rejection
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeline read exceeded ${timeoutMs} ms`)), timeoutMs);
    });
    const page = await Promise.race([read, timeout]);
    const texts: string[] = [];
    for (const entry of page.entries as Array<{ item: Record<string, unknown> }>) {
      for (const key of ["text", "message", "error"]) {
        const value = entry.item?.[key];
        if (typeof value === "string") texts.push(value);
      }
    }
    return hasLimitEvidence(texts);
  } catch (error) {
    console.error(
      `[resume-guard] ${agentId.slice(0, 8)} no limit evidence (timeline unreadable or too slow), blocking as ordinary resume:`,
      (error as Error)?.message ?? error,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export default function contribute(
  server: PluginServerContext,
  stateFile: string = STATE_FILE,
  evidenceTimeoutMs: number = EVIDENCE_TIMELINE_TIMEOUT_MS,
) {
  const allowedAt = loadAllowedAt(stateFile);
  const settingsHandle = server.registerSettings(resumeGuardSettings);

  async function thresholdTokens(): Promise<number> {
    try {
      return resolveThreshold(await settingsHandle.read(), DEFAULT_THRESHOLD_TOKENS);
    } catch (error) {
      // Unreadable settings: enforce with the default. Never allow unconditionally.
      console.error(
        `[resume-guard] settings read failed, enforcing default ${DEFAULT_THRESHOLD_TOKENS}:`,
        (error as Error)?.message ?? error,
      );
      return DEFAULT_THRESHOLD_TOKENS;
    }
  }

  async function rotationWindowMs(): Promise<number> {
    try {
      return resolveRotationMinutes(await settingsHandle.read(), DEFAULT_ROTATION_EXEMPT_MINUTES) * 60_000;
    } catch {
      return DEFAULT_ROTATION_EXEMPT_MINUTES * 60_000;
    }
  }

  const off = server.addHook("agent.open.before", async ({ request }, { paseo }) => {
    const threshold = await thresholdTokens();
    let snapshot: ResumeSnapshot;
    let ref: any;
    try {
      ref = paseo.agents.ref(request.agentId);
      await ref.refresh();
      snapshot = { status: ref.status, lastUsage: ref.lastUsage };
    } catch (error) {
      // Unreadable snapshot: the guard cannot confirm status "error", so it must not block (fail-open).
      // Blocking here would stall every agent open on a transient SDK failure.
      console.error(
        `[resume-guard] ${request.agentId.slice(0, 8)} snapshot unreadable, allowing open:`,
        (error as Error)?.message ?? error,
      );
      return undefined;
    }
    if (!shouldBlockResume(snapshot, threshold)) {
      const tokens = snapshot.lastUsage?.contextWindowUsedTokens;
      console.log(
        `[resume-guard] ${request.agentId.slice(0, 8)} ${request.reason}: allow ` +
          `(status ${String(snapshot.status ?? "unreadable")}, ${typeof tokens === "number" ? approxK(tokens) : "no usage recorded"})`,
      );
      return undefined;
    }
    const tokens = snapshot.lastUsage?.contextWindowUsedTokens ?? 0;
    if (request.reason === "refresh") {
      const now = Date.now();
      const allowed = shouldAllowRotation({
        reason: request.reason,
        status: snapshot.status,
        archived: Boolean(ref.archivedAt),
        limitEvidence: await limitEvidence(ref, request.agentId, evidenceTimeoutMs),
        lastAllowedAt: allowedAt.get(request.agentId),
        now,
        windowMs: await rotationWindowMs(),
      });
      if (allowed) {
        allowedAt.set(request.agentId, now);
        saveAllowedAt(stateFile, allowedAt);
        console.log(rotationLogLine(request.agentId, tokens));
        return undefined;
      }
    }
    console.log(logLine(request.agentId, tokens, threshold));
    throw new Error(buildDenyMessage(request.agentId, tokens, threshold));
  });

  return () => off();
}
