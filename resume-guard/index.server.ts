import type { PluginServerContext } from "@getpaseo/plugin/server";
import { buildDenyMessage, logLine, approxK, resolveThreshold, shouldBlockResume, type ResumeSnapshot } from "./shared/decision.ts";
import { DEFAULT_THRESHOLD_TOKENS, resumeGuardSettings } from "./shared/settings.ts";

// resume-guard: one agent.open.before hook. An open (create, resume, refresh, import) is blocked when the agent
// snapshot has status "error" and its recorded context usage is above the threshold, because resuming such an
// agent would pay for its whole context again. The deny message tells the sender to write a handoff file and
// spawn a fresh agent instead.
//
// Known limit: a throw from agent.open.before surfaces to the client as the generic
// "Plugin resume-guard agent.open.before failed: <message>" failure text, not a custom deny message. The whole
// reason lives in the thrown error text for that reason.
export default function contribute(server: PluginServerContext) {
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

  const off = server.addHook("agent.open.before", async ({ request }, { paseo }) => {
    const threshold = await thresholdTokens();
    let snapshot: ResumeSnapshot;
    try {
      const ref = paseo.agents.ref(request.agentId);
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
    console.log(logLine(request.agentId, tokens, threshold));
    throw new Error(buildDenyMessage(request.agentId, tokens, threshold));
  });

  return () => off();
}
