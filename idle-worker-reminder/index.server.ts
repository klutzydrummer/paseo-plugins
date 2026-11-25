import type { PluginServerContext } from "@getpaseo/plugin/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_DELAY_MS, isWorker, parentOf, parseDelay, reminderText, type Labels } from "./shared/decision";

// idle-worker-reminder: WARN ONLY. Never archives. After a worker's turn ends and nothing happens for the delay,
// append one timeline row to the worker and send one line to its parent. A new turn re-arms; an archive cancels.
// turn_ended's agent has no labels, so labels are recorded from agent.session_open (same trick as context-compact).

const DELAY_FILE = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
  "paseo-plugins", "idle-worker-reminder", "delay_ms",
);

function delayMs(): number {
  let fromFile: number | null = null;
  try { fromFile = parseDelay(fs.readFileSync(DELAY_FILE, "utf8")); } catch { /* no file */ }
  return fromFile ?? parseDelay(process.env.IDLE_WORKER_REMINDER_MS) ?? DEFAULT_DELAY_MS;
}

export default function contribute(server: PluginServerContext) {
  const labels = new Map<string, Labels>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const cancel = (id: string) => {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
  };

  const removeOpen = server.before("agent.session_open", ({ request }) => {
    labels.set(request.agentId, { ...request.labels });
    return undefined;
  });
  const removeStart = server.on("agent.turn_started", ({ agent }) => cancel(agent.id));
  const removeArchive = server.on("agent.archived", ({ agent }) => { cancel(agent.id); labels.delete(agent.id); });
  const removeClosed = server.on("agent.closed", ({ agent }) => cancel(agent.id));

  const removeEnd = server.on("agent.turn_ended", ({ agent, outcome }, { paseo }) => {
    cancel(agent.id);
    if (outcome.kind !== "completed") return;
    const l = labels.get(agent.id);
    if (!isWorker(agent, l)) return;
    const parent = parentOf(agent, l)!;
    const delay = delayMs();
    const id = agent.id;
    const timer = setTimeout(async () => {
      timers.delete(id); // fires once; only a new turn_ended re-arms
      const text = reminderText(id, delay);
      try {
        await paseo.agents.ref(id).timeline.append({
          type: "plugin", id: "idle-reminder", kind: "idle-worker-reminder", version: 1,
          data: { text, at: new Date().toISOString() },
        });
      } catch (e) { console.error("[idle-worker-reminder] timeline append failed:", (e as Error)?.message ?? e); }
      try {
        await paseo.agents.ref(parent).send(text);
        console.log(`[idle-worker-reminder] ${id.slice(0, 8)} -> ${parent.slice(0, 8)}: ${text}`);
      } catch (e) { console.error("[idle-worker-reminder] send to parent failed:", (e as Error)?.message ?? e); }
    }, delay);
    timers.set(id, timer);
  });

  return () => {
    for (const id of [...timers.keys()]) cancel(id);
    removeOpen(); removeStart(); removeArchive(); removeClosed(); removeEnd();
  };
}
