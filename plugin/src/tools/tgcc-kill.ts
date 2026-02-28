/**
 * tgcc_kill tool — Kill a TGCC CC session or destroy an ephemeral agent.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { TgccSupervisorClient } from "../client.js";

const TgccKillParams = Type.Object({
  agentId: Type.String({ description: "TGCC agent ID to kill" }),
  destroy: Type.Optional(
    Type.Boolean({
      description: "If true, destroy the ephemeral agent entirely (not just kill CC). Default: false.",
    }),
  ),
});

type KillParams = Static<typeof TgccKillParams>;

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

export function createTgccKillTool(
  getClient: () => TgccSupervisorClient | null,
): AnyAgentTool {
  return {
    name: "tgcc_kill",
    label: "TGCC Kill",
    description:
      "Kill a running CC process on a TGCC agent, or destroy an ephemeral agent entirely. " +
      "Use destroy=true to remove the agent (only works for ephemeral agents).",
    parameters: TgccKillParams,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const p = params as unknown as KillParams;
      const client = getClient();
      if (!client?.isConnected()) {
        return json({ error: "Not connected to TGCC" });
      }

      if (!p.agentId) {
        return json({ error: "agentId is required" });
      }

      try {
        if (p.destroy) {
          const result = await client.destroyAgent(p.agentId);
          return json({ agentId: p.agentId, destroyed: result.destroyed });
        }

        await client.killCC(p.agentId);
        return json({ agentId: p.agentId, killed: true });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
