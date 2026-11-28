// Pure decision logic for resume-guard, extracted from index.server.ts so it can be unit tested
// without Paseo. No Paseo imports, so Node can run this file directly.

/** The part of a Paseo agent snapshot the guard inspects. */
export interface ResumeSnapshot {
  status: string | null | undefined;
  lastUsage: { contextWindowUsedTokens?: number } | null | undefined;
}

/**
 * Block exactly when the snapshot status is "error" AND the recorded context usage is strictly
 * above the threshold. Any other status (running, idle, initializing, closed), an unreadable
 * status, or a missing token count never blocks.
 */
export function shouldBlockResume(snapshot: ResumeSnapshot, thresholdTokens: number): boolean {
  if (snapshot.status !== "error") return false;
  const tokens = snapshot.lastUsage?.contextWindowUsedTokens;
  return typeof tokens === "number" && tokens > thresholdTokens;
}

/** `60000` -> `~60k`. */
export const approxK = (tokens: number): string => `~${Math.round(tokens / 1000)}k`;

/** The reason thrown when the guard blocks an open. `<task>` is a placeholder for the sender's task directory. */
export function buildDenyMessage(agentId: string, tokens: number, thresholdTokens: number): string {
  return (
    `resume-guard: agent ${agentId} may not be opened (status "error" with ${approxK(tokens)} context tokens, ` +
    `above the ${approxK(thresholdTokens)} threshold). Do not resume it — write/refresh ` +
    `<task>/workers/${agentId}/handoff.md (replace <task> with the task directory it was launched from) ` +
    `and spawn a fresh agent pointed at it.`
  );
}

export function logLine(agentId: string, tokens: number, thresholdTokens: number): string {
  return (
    `[resume-guard] ${agentId.slice(0, 8)} blocked: status error, ${approxK(tokens)} tokens > ` +
    `${approxK(thresholdTokens)} threshold`
  );
}

/** The threshold the hook enforces. Unreadable/invalid settings fall back to the default; never skip the guard. */
export function resolveThreshold(read: unknown, fallback: number): number {
  const rec = (typeof read === "object" && read !== null ? read : null) as {
    status?: unknown;
    values?: { thresholdTokens?: unknown } | null;
  } | null;
  if (!rec || rec.status !== "ready") return fallback;
  const tokens = rec.values?.thresholdTokens;
  return typeof tokens === "number" ? tokens : fallback;
}

// --- One-shot limit-rotation exemption -------------------------------------------------------------------
// ZeroSub moves an agent that hit an account limit by reloading it (reason "refresh"). The agent is in status
// "error" at that moment, so the guard would block the reload. The payload cannot tell a rotation from a manual
// refresh, so the guard asks for evidence: the agent's recent timeline carries the CLI's own limit notice.

/** CLI limit notices ZeroSub documents: "You've hit your 5-hour limit", "You've reached your Fable 5.2 limit", "The usage limit has been reached". */
const LIMIT_NOTICE = /\byou['\u2019]ve (?:hit|reached) your [^\n]{0,60}?limit\b|\busage limit has been reached\b/i;

/** True when any text looks like a CLI account-limit notice. */
export function hasLimitEvidence(texts: readonly string[]): boolean {
  return texts.some((text) => LIMIT_NOTICE.test(text));
}

export interface RotationInput {
  reason: string | undefined;
  status: string | null | undefined;
  archived: boolean;
  limitEvidence: boolean;
  /** Epoch ms of the last rotation allow for this agent, if any. */
  lastAllowedAt: number | undefined;
  now: number;
  windowMs: number;
}

/** Allow exactly when a refresh of a non-archived errored agent has limit evidence and no rotation allow happened within the window. */
export function shouldAllowRotation(input: RotationInput): boolean {
  if (input.reason !== "refresh" || input.status !== "error" || input.archived || !input.limitEvidence) return false;
  return input.lastAllowedAt === undefined || input.now - input.lastAllowedAt >= input.windowMs;
}

export function rotationLogLine(agentId: string, tokens: number | undefined): string {
  return `[resume-guard] ${agentId.slice(0, 8)} rotation allow: refresh of errored agent with limit notice` +
    ` (${typeof tokens === "number" ? approxK(tokens) : "no usage recorded"})`;
}

/** The exemption window. Unreadable/invalid settings fall back to the default. */
export function resolveRotationMinutes(read: unknown, fallback: number): number {
  const rec = (typeof read === "object" && read !== null ? read : null) as {
    status?: unknown;
    values?: { rotationExemptMinutes?: unknown } | null;
  } | null;
  if (!rec || rec.status !== "ready") return fallback;
  const minutes = rec.values?.rotationExemptMinutes;
  return typeof minutes === "number" && minutes >= 0 ? minutes : fallback;
}
