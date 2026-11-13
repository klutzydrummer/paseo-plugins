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
