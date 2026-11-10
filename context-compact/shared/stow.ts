// Pure stow/handoff logic (no Paseo imports). The plugin wires `stow` to an agent tool and `onTurnEnded` to
// the agent.turn_ended hook; `send` and `waitIdle` are injected so tests run with a fake.

export interface StowDeps {
  /** Send a prompt to the agent. For `/clear` this must reach Claude WITHOUT Paseo's caller-identity header. */
  sendClear(agentId: string): Promise<void>;
  sendText(agentId: string, text: string): Promise<void>;
  /** Resolve when the agent is idle again (after /clear). Reject/throw on timeout. */
  waitIdle(agentId: string): Promise<void>;
}

export const STOW_ACK = "Handoff stowed. End your turn now; your context will be cleared and the text sent back to you.";

export function createStow(deps: StowDeps) {
  const stowed = new Map<string, string>();
  return {
    /** Store text for the CALLING agent (id comes from the tool-call context). Replaces an earlier call. */
    stow(agentId: string, text: string): { ok: boolean; message: string } {
      if (typeof text !== "string" || text.trim() === "") return { ok: false, message: "stow_handoff: text must not be empty." };
      stowed.set(agentId, text);
      return { ok: true, message: STOW_ACK };
    },
    has: (agentId: string) => stowed.has(agentId),
    /** Returns true if a handoff was performed. */
    async onTurnEnded(agentId: string, outcomeKind: string): Promise<boolean> {
      if (outcomeKind !== "completed") return false;
      const text = stowed.get(agentId);
      if (text === undefined) return false;
      stowed.delete(agentId); // one-shot: removed BEFORE any send
      await deps.sendClear(agentId);
      await deps.waitIdle(agentId);
      await deps.sendText(agentId, text);
      return true;
    },
  };
}
