import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// resume-guard — settings document. Edited from Settings → Plugins → Resume Guard, or by hand in
// <paseoHome>/plugin-settings/resume-guard/config.json (store envelope `{ "version": 1, "values": { ... } }`).

export const DEFAULT_THRESHOLD_TOKENS = 30_000;
export const DEFAULT_ROTATION_EXEMPT_MINUTES = 30;

export const ResumeGuardSettingsSchema = z.object({
  /**
   * An agent open is blocked when the agent snapshot has status "error" and its lastUsage
   * contextWindowUsedTokens is strictly above this many tokens. Only the "error" status is ever
   * blocked; running/idle/initializing/closed agents always open.
   */
  thresholdTokens: z.number().int().min(1).max(2_000_000).default(DEFAULT_THRESHOLD_TOKENS),
  /**
   * A refresh of an errored agent whose timeline shows a CLI limit notice (an account rotation) is allowed once.
   * A second one within this many minutes is blocked again, which stops reload loops. 0 allows every rotation.
   */
  rotationExemptMinutes: z.number().min(0).max(1440).default(DEFAULT_ROTATION_EXEMPT_MINUTES),
});

export type ResumeGuardSettings = z.output<typeof ResumeGuardSettingsSchema>;

export const resumeGuardSettings = defineSettings({
  id: "config",
  scope: "host",
  version: 1,
  schema: ResumeGuardSettingsSchema,
  migrate: (values) => values,
});

export const DEFAULT_SETTINGS: ResumeGuardSettings = ResumeGuardSettingsSchema.parse({});
