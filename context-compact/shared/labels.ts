// The agent.turn_ended event's `agent` has no `labels` field (Paseo hooks docs), so labels are recorded from the
// `agent.open.before` request (agentId + labels; fires on create/resume/refresh/import) and joined back at turn end.
export type Labels = Record<string, string>;

export function createLabelStore() {
  const byAgent = new Map<string, Labels>();
  return {
    record(agentId: string | undefined, labels: Labels | null | undefined): void {
      if (!agentId) return;
      if (labels && typeof labels === "object") byAgent.set(agentId, { ...labels });
      else byAgent.delete(agentId);
    },
    forget: (agentId: string): void => void byAgent.delete(agentId),
    /** The event agent with recorded labels attached; no record means unlabelled (never nudged as a child). */
    withLabels<A extends object>(agent: A & { id: string }): A & { labels?: Labels } {
      const labels = byAgent.get(agent.id);
      return labels ? { ...agent, labels } : { ...agent };
    },
  };
}
