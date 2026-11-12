// Providers whose mode list has both "default" (Always Ask) and "auto" (checked with list_providers, 2026-11-12).
export const GUARDED_PROVIDERS: readonly string[] = [
  "claude",
  "claude-sandbox",
  "deepseek",
  "deepseek-lite",
  "deepseek-orch",
  "deepseek-sandbox",
  "kimi",
];

export const FROM_MODE = "default";
export const TO_MODE = "auto";

type Config = { provider?: unknown; modeId?: unknown; title?: unknown; [key: string]: unknown };
type Request = { config?: Config; [key: string]: unknown };

export type GuardResult<R> = { request: R; rewritten: boolean };

// Pure: returns a new request when it rewrites, otherwise the same object. Never mutates the input.
export function guardMode<R extends Request>(request: R, providers: readonly string[] = GUARDED_PROVIDERS): GuardResult<R> {
  const config = request?.config;
  if (!config || config.modeId !== FROM_MODE) return { request, rewritten: false };
  if (typeof config.provider !== "string" || !providers.includes(config.provider)) return { request, rewritten: false };
  return { request: { ...request, config: { ...config, modeId: TO_MODE } }, rewritten: true };
}

export function logLine(request: Request): string {
  const c = request.config ?? {};
  const title = typeof c.title === "string" && c.title ? ` "${c.title}"` : "";
  return `[mode-guard] ${String(c.provider)}${title}: modeId ${FROM_MODE} -> ${TO_MODE}`;
}
