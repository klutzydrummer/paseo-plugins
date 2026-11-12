// Pure decision logic for context-compact, extracted from index.server.ts (no behaviour change) so it can be unit
// tested without Paseo. Imports are type-only so Node can run this file directly.
import type { ContextCompactSettings } from "./settings";

export const PREFIX = "[context-compact]";

export const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

/** session_open: does this provider get the compaction env? */
export const providerMatches = (s: Pick<ContextCompactSettings, "enabled" | "providers">, provider: string): boolean =>
  s.enabled && s.providers.includes(provider);

/** turn_ended: is this turn even eligible for a nudge check (before any transcript read)? */
export function turnEligible(
  s: Pick<ContextCompactSettings, "enabled" | "handoffPct" | "providers"> &
    Partial<Pick<ContextCompactSettings, "nudgeLabelKey" | "nudgeLabelValue">>,
  agent: { provider: string; parentAgentId?: string | null; labels?: Record<string, string> | null },
  outcomeKind: string,
): boolean {
  if (!s.enabled || s.handoffPct <= 0 || !s.providers.includes(agent.provider)) return false;
  if (agent.parentAgentId) {
    // Child agents are nudged only with the opt-in label (default studio.role=mm); workers stay unnudged.
    const key = s.nudgeLabelKey ?? "studio.role";
    const value = s.nudgeLabelValue ?? "mm";
    if (!key || agent.labels?.[key] !== value) return false;
  }
  return outcomeKind === "completed";
}

export const contextPct = (tokens: number, windowTokens: number): number => Math.round((100 * tokens) / windowTokens);

/** How far an agent has been nudged in the current arm: 0 none, 1 soft sent, 2 hard sent. */
export type NudgeLevel = 0 | 1 | 2;

/**
 * "rearm": below handoffPct (clear the level); "skip": at/over compactPct or nothing new to send;
 * "soft": at/over handoffPct, not yet nudged; "hard": at/over hardHandoffPct (>0), hard not yet sent.
 */
export function classifyPct(
  pct: number,
  s: Pick<ContextCompactSettings, "handoffPct" | "compactPct" | "hardHandoffPct">,
  level: NudgeLevel,
): "rearm" | "skip" | "soft" | "hard" {
  if (pct < s.handoffPct) return "rearm";
  if (pct >= s.compactPct) return "skip";
  if (s.hardHandoffPct > 0 && pct >= s.hardHandoffPct && level < 2) return "hard";
  if (level < 1) return "soft";
  return "skip";
}

/** Never answer a nudge with a nudge. */
export const isNudgeEcho = (lastUserText: string | undefined): boolean => (lastUserText ?? "").startsWith(PREFIX);

export function buildNudgeText(s: ContextCompactSettings, pct: number, kind: "soft" | "hard" = "soft"): string {
  const text = fill(kind === "hard" ? s.hardHandoffPrompt : s.handoffPrompt, {
    pct: String(pct),
    window: s.windowTokens.toLocaleString("en-US"),
    compact: String(s.compactPct),
  });
  return text.startsWith(PREFIX) ? text : `${PREFIX} ${text}`;
}
