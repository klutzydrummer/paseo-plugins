export type Labels = Record<string, string>;
export const DEFAULT_DELAY_MS = 10 * 60 * 1000;

export function parentOf(agent: { parentAgentId: string | null }, labels: Labels | undefined): string | null {
  return agent.parentAgentId ?? labels?.["paseo.parent-agent-id"] ?? null;
}

/** A worker has a parent, a studio.task or studio.readonly label, and is not a manager. */
export function isWorker(agent: { parentAgentId: string | null }, labels: Labels | undefined): boolean {
  if (!labels || !parentOf(agent, labels)) return false;
  if (labels["studio.role"] === "mm") return false;
  return Boolean(labels["studio.task"]) || Boolean(labels["studio.readonly"]);
}

export function parseDelay(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : null;
}

export function reminderText(id: string, delayMs: number): string {
  const min = delayMs >= 60_000 ? Math.round(delayMs / 60_000) : delayMs / 1000;
  const unit = delayMs >= 60_000 ? "min" : "s";
  return `worker ${id.slice(0, 8)} idle ~${min} ${unit}: archive if accepted`;
}
