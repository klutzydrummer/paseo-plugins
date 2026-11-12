import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// context-compact — settings document. Edited from Settings → Plugins → Context Compact, or by hand in
// <paseoHome>/plugin-settings/context-compact/config.json (store envelope `{ "version": 1, "values": { ... } }`).
//
// Claude Code compacts when the context reaches compactPct % of windowTokens. The plugin hands both to every Claude
// session it opens as CLAUDE_AUTOCOMPACT_PCT_OVERRIDE and CLAUDE_CODE_AUTO_COMPACT_WINDOW. A value changed here
// reaches a chat on its NEXT open (new agent, resume, refresh) — a running Claude process keeps the env it started with.

export const ContextCompactSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Paseo provider ids whose sessions get the env (each must run Claude Code). */
  providers: z.array(z.string()).default(["claude"]),
  /** Compact at this % of windowTokens. */
  compactPct: z.number().int().min(10).max(100).default(60),
  /** The window the % applies to. 1,000,000 = the 1M models' full window. */
  windowTokens: z.number().int().min(50_000).max(2_000_000).default(1_000_000),
  /**
   * Soft nudge: once an eligible agent's context passes this % of windowTokens, ask it to finish its current step and
   * hand off at the next clean stopping point (0 = no nudges at all). BEST-EFFORT: checked at turn end only, so a
   * single long turn (large tool outputs) can cross this, hardHandoffPct and the compaction threshold before it is
   * checked. Pair it with a Claude Code PostCompact/SessionStart hook if you need a guarantee.
   */
  handoffPct: z.number().int().min(0).max(100).default(50),
  /** Hard nudge: past this % of windowTokens, tell the agent to hand off now. Fires once per arm, like the soft one. */
  hardHandoffPct: z.number().int().min(0).max(100).default(75),
  /**
   * Opt-in label for child agents: a child (parentAgentId set) is nudged only when it carries this label key with
   * this value (e.g. middle managers spawned with `studio.role=mm`). Top-level agents are always eligible; children
   * without the label never are. Empty nudgeLabelKey disables the child opt-in.
   */
  nudgeLabelKey: z.string().default("studio.role"),
  nudgeLabelValue: z.string().default("mm"),
  /** Soft nudge text. {pct} {window} {compact} are substituted. */
  handoffPrompt: z
    .string()
    .default(
      "[context-compact] Your context is at {pct}% of {window} tokens; auto-compaction runs at {compact}%. " +
        "Finish the current step, start no new phase, and self-hand off at the next clean stopping point without " +
        "asking the user: write your state file and a handoff file, call stow_handoff(<short pointer text>) saying " +
        "the handoff file is the source of truth and wins on any conflict, then end your turn. If stow_handoff is " +
        "unavailable, write the handoff file and report its path to your parent (the user, if you are top level).",
    ),
  /** Hard nudge text (same substitutions). */
  hardHandoffPrompt: z
    .string()
    .default(
      "[context-compact] Your context is at {pct}% of {window} tokens; auto-compaction runs at {compact}%. " +
        "Hand off now without asking the user: write your state file and a handoff file, call " +
        "stow_handoff(<short pointer text>) saying the handoff file is the source of truth and wins on any " +
        "conflict, then end your turn. If stow_handoff is unavailable, write the handoff file and report its path " +
        "to your parent (the user, if you are top level).",
    ),
});

export type ContextCompactSettings = z.output<typeof ContextCompactSettingsSchema>;

export const contextCompactSettings = defineSettings({
  id: "config",
  scope: "host",
  version: 1,
  schema: ContextCompactSettingsSchema,
  migrate: (values) => values,
});

export const DEFAULT_SETTINGS: ContextCompactSettings = ContextCompactSettingsSchema.parse({});

/** The env a Claude session gets. */
export function compactEnv(s: ContextCompactSettings): Record<string, string> {
  return {
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(s.compactPct),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(s.windowTokens),
  };
}
