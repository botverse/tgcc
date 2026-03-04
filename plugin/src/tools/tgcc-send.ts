/**
 * tgcc_send tool — Send a message to an existing TGCC session.
 *
 * Sends a follow-up message to a running CC process, or starts one
 * if the agent is idle.
 */

import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { TgccSupervisorClient } from "../client.js";

const TgccSendParams = {
  type: "object",
  properties: {
    agentId: { type: "string", description: "TGCC agent ID to send to" },
    text: { type: "string", description: "Message text to send" },
    followUp: {
      type: "boolean",
      description: "If true, send to running CC process (sendToCC). If false or omitted, send as new message (may spawn CC).",
    },
    newSession: {
      type: "boolean",
      description: "If true, clear the current session before sending (start fresh). Cannot be combined with sessionId.",
    },
    sessionId: {
      type: "string",
      description: "Resume a specific session by ID before sending. Cannot be combined with newSession.",
    },
    model: {
      type: "string",
      description: "Switch the agent's model before sending, e.g. 'opus', 'sonnet', 'haiku'.",
    },
  },
  required: ["agentId", "text"],
} as const;

interface SendParams {
  agentId: string;
  text: string;
  followUp?: boolean;
  newSession?: boolean;
  sessionId?: string;
  model?: string;
}

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
      "a CC process if idle). Set followUp=true to send to an already-running CC process. " +
      "Optional: newSession=true (start fresh), sessionId (resume specific session), model (switch model) — " +
      "these apply before sending, enabling one-call session management + task dispatch.",
    parameters: TgccSendParams as Record<string, unknown>,
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
        // Apply pre-send session management in order: model → session → send
        if (p.model) {
          await client.setAgentModel(p.agentId, p.model);
        }

        if (p.newSession) {
          await client.sessionNew(p.agentId);
        } else if (p.sessionId) {
          await client.sessionResume(p.agentId, p.sessionId);
        }

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
