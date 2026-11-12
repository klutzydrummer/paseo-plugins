import type { PluginServerContext } from "@getpaseo/plugin/server";
import { guardMode, logLine } from "./shared/guard.ts";

// mode-guard: one agent.create.before hook. An agent created with modeId "default" (Always Ask) gets "auto" instead.
// Every other mode, and an absent modeId (Paseo then applies the provider default, "auto"), is left alone.
// Never maps to bypassPermissions.
export default function contribute(server: PluginServerContext) {
  const off = server.addHook("agent.create.before", async ({ request }) => {
    const { request: next, rewritten } = guardMode(request as never);
    if (!rewritten) return undefined;
    console.log(logLine(next as never));
    return next as never;
  });
  return () => off();
}
