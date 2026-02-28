/**
 * tgcc_spawn tool — Spawn a CC session via TGCC.
 *
 * Sends a task to a TGCC agent, which spawns a Claude Code process.
 * Subscribes to the agent's events so results flow back through the plugin.
 */

import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { TgccSupervisorClient } from "../client.js";

const TgccSpawnParams = {
  type: "object",
  properties: {
    agentId: { type: "string", description: "TGCC agent ID to send the task to" },
    task: { type: "string", description: "Task description / prompt for Claude Code" },
    repo: { type: "string", description: "Repository path (for ephemeral agents)" },
    model: { type: "string", description: "Model override (e.g. 'opus', 'sonnet')" },
    permissionMode: { type: "string", description: "CC permission mode (e.g. 'plan', 'default')" },
  },
  required: ["agentId", "task"],
} as const;

interface SpawnParams {
  agentId: string;
  task: string;
  repo?: string;
  model?: string;
  permissionMode?: string;
}

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

export function createTgccSpawnTool(
  getClient: () => TgccSupervisorClient | null,
  defaultAgent?: string,
): AnyAgentTool {
  return {
    name: "tgcc_spawn",
    label: "TGCC Spawn",
    description:
      "Spawn a Claude Code session via TGCC. Sends a task to a TGCC agent which runs " +
      "Claude Code in a managed process. Returns the session ID for tracking. " +
      "Use tgcc_status to check progress and get results.",
    parameters: TgccSpawnParams as Record<string, unknown>,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const p = params as unknown as SpawnParams;
      const client = getClient();
      if (!client?.isConnected()) {
        return json({ error: "Not connected to TGCC" });
      }

      const agentId = p.agentId || defaultAgent;
      if (!agentId) {
        return json({ error: "agentId is required (no default configured)" });
      }
      if (!p.task) {
        return json({ error: "task is required" });
      }

      try {
        // If a repo is specified, create an ephemeral agent first
        if (p.repo) {
          const created = await client.createAgent({
            agentId: p.agentId || undefined,
            repo: p.repo,
            model: p.model,
            permissionMode: p.permissionMode,
          });
          const result = await client.sendMessage(created.agentId, p.task, { subscribe: true });
          return json({
            agentId: created.agentId,
            sessionId: result.sessionId,
            state: result.state,
            subscribed: result.subscribed,
            ephemeral: true,
          });
        }

        // Send to existing agent
        const result = await client.sendMessage(agentId, p.task, { subscribe: true });
        return json({
          agentId,
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
