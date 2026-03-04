/**
 * tgcc_session tool — Session management for TGCC agents.
 *
 * Covers all session lifecycle operations: list, new, continue, resume,
 * cancel, compact, and changing model/repo/permissions.
 */

import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { TgccSupervisorClient } from "../client.js";

const TgccSessionParams = {
  type: "object",
  properties: {
    agentId: { type: "string", description: "TGCC agent ID" },
    action: {
      type: "string",
      enum: ["list", "new", "continue", "resume", "cancel", "compact", "set_model", "set_repo", "set_permissions"],
      description:
        "list: show recent sessions | new: clear session (next message starts fresh) | " +
        "continue: preserve session for auto-resume | resume: resume specific session by ID | " +
        "cancel: cancel current turn (process stays alive) | compact: trigger context compaction | " +
        "set_model: change CC model | set_repo: change agent repo | set_permissions: change permission mode",
    },
    sessionId: { type: "string", description: "Session ID to resume (required for action=resume)" },
    model: { type: "string", description: "Model name, e.g. 'opus', 'sonnet', 'haiku' (required for action=set_model)" },
    repo: { type: "string", description: "Repo name or path (required for action=set_repo)" },
    mode: {
      type: "string",
      enum: ["dangerously-skip", "acceptEdits", "default", "plan"],
      description: "Permission mode (required for action=set_permissions)",
    },
    instructions: { type: "string", description: "Compaction instructions (optional for action=compact)" },
    limit: { type: "number", description: "Max sessions to return (optional for action=list, default: 10)" },
  },
  required: ["agentId", "action"],
} as const;

interface SessionParams {
  agentId: string;
  action: string;
  sessionId?: string;
  model?: string;
  repo?: string;
  mode?: string;
  instructions?: string;
  limit?: number;
}

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

export function createTgccSessionTool(
  getClient: () => TgccSupervisorClient | null,
): AnyAgentTool {
  return {
    name: "tgcc_session",
    label: "TGCC Session",
    description:
      "Manage TGCC agent sessions without sending a message. " +
      "List sessions, start fresh, continue/resume a specific session, " +
      "cancel the current turn, trigger compaction, or change model/repo/permissions.",
    parameters: TgccSessionParams as Record<string, unknown>,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const p = params as unknown as SessionParams;
      const client = getClient();
      if (!client?.isConnected()) {
        return json({ error: "Not connected to TGCC" });
      }

      if (!p.agentId || !p.action) {
        return json({ error: "agentId and action are required" });
      }

      try {
        switch (p.action) {
          case "list":
            return json(await client.sessionList(p.agentId, p.limit));

          case "new":
            return json(await client.sessionNew(p.agentId));

          case "continue":
            return json(await client.sessionContinue(p.agentId));

          case "resume":
            if (!p.sessionId) return json({ error: "sessionId required for action=resume" });
            return json(await client.sessionResume(p.agentId, p.sessionId));

          case "cancel":
            return json(await client.cancelTurn(p.agentId));

          case "compact":
            return json(await client.compact(p.agentId, p.instructions));

          case "set_model":
            if (!p.model) return json({ error: "model required for action=set_model" });
            return json(await client.setAgentModel(p.agentId, p.model));

          case "set_repo":
            if (!p.repo) return json({ error: "repo required for action=set_repo" });
            return json(await client.setAgentRepo(p.agentId, p.repo));

          case "set_permissions":
            if (!p.mode) return json({ error: "mode required for action=set_permissions" });
            return json(await client.setAgentPermissions(p.agentId, p.mode));

          default:
            return json({ error: `Unknown action: ${p.action}` });
        }
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
