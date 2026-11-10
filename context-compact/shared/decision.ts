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
  s: Pick<ContextCompactSettings, "enabled" | "handoffPct" | "providers">,
  agent: { provider: string; parentAgentId?: string | null },
  outcomeKind: string,
): boolean {
  if (!s.enabled || s.handoffPct <= 0 || !s.providers.includes(agent.provider)) return false;
  if (agent.parentAgentId) return false;
  return outcomeKind === "completed";
}

export const contextPct = (tokens: number, windowTokens: number): number => Math.round((100 * tokens) / windowTokens);

/** "rearm": below handoffPct (clear the nudged flag); "skip": at/over compactPct or already nudged; else "candidate". */
export function classifyPct(
  pct: number,
  s: Pick<ContextCompactSettings, "handoffPct" | "compactPct">,
  alreadyNudged: boolean,
): "rearm" | "skip" | "candidate" {
  if (pct < s.handoffPct) return "rearm";
  if (pct >= s.compactPct || alreadyNudged) return "skip";
  return "candidate";
}

/** Never answer a nudge with a nudge. */
export const isNudgeEcho = (lastUserText: string | undefined): boolean => (lastUserText ?? "").startsWith(PREFIX);

export function buildNudgeText(s: ContextCompactSettings, pct: number): string {
  const text = fill(s.handoffPrompt, {
    pct: String(pct),
    window: s.windowTokens.toLocaleString("en-US"),
    compact: String(s.compactPct),
  });
  return text.startsWith(PREFIX) ? text : `${PREFIX} ${text}`;
}
