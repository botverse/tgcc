/**
 * tgcc_send tool — Send a message to an existing TGCC session.
 *
 * Sends a follow-up message to a running CC process, or starts one
 * if the agent is idle.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { TgccSupervisorClient } from "../client.js";

const TgccSendParams = Type.Object({
  agentId: Type.String({ description: "TGCC agent ID to send to" }),
  text: Type.String({ description: "Message text to send" }),
  followUp: Type.Optional(
    Type.Boolean({
      description: "If true, send to running CC process (sendToCC). If false or omitted, send as new message (may spawn CC).",
    }),
  ),
});

type SendParams = Static<typeof TgccSendParams>;

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

export function createTgccSendTool(
  getClient: () => TgccSupervisorClient | null,
): AnyAgentTool {
  return {
    name: "tgcc_send",
    label: "TGCC Send",
    description:
      "Send a message to a TGCC agent. By default sends a new message (which may spawn " +
      "a CC process if idle). Set followUp=true to send to an already-running CC process.",
    parameters: TgccSendParams,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const p = params as unknown as SendParams;
      const client = getClient();
      if (!client?.isConnected()) {
        return json({ error: "Not connected to TGCC" });
      }

      if (!p.agentId || !p.text) {
        return json({ error: "agentId and text are required" });
      }

      try {
        if (p.followUp) {
          const result = await client.sendToCC(p.agentId, p.text);
          return json({ agentId: p.agentId, sent: result.sent, followUp: true });
        }

        const result = await client.sendMessage(p.agentId, p.text, { subscribe: true });
        return json({
          agentId: p.agentId,
          sessionId: result.sessionId,
          state: result.state,
          subscribed: result.subscribed,
        });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
