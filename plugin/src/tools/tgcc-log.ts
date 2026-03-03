/**
 * tgcc_log tool — View the event log for a TGCC agent's CC session.
 *
 * Wraps the getLog() client method to expose it as an agent tool.
 * Shows build results, commits, milestones, errors, and assistant output.
 */

import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { TgccSupervisorClient } from "../client.js";

const TgccLogParams = {
  type: "object",
  properties: {
    agentId: { type: "string", description: "Agent ID to get log for" },
    offset: { type: "number", description: "Start from line N" },
    limit: { type: "number", description: "Max lines to return (default: 30)" },
    grep: { type: "string", description: "Regex filter — only return matching lines" },
    since: {
      type: "number",
      description: "Only return events from last N milliseconds (e.g. 60000 = last minute)",
    },
    type: {
      type: "string",
      description: 'Filter by entry type: "text" | "tool" | "system" | "error" | "user"',
    },
  },
  required: ["agentId"],
} as const;

interface LogParams {
  agentId: string;
  offset?: number;
  limit?: number;
  grep?: string;
  since?: number;
  type?: string;
}

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

export function createTgccLogTool(getClient: () => TgccSupervisorClient | null): AnyAgentTool {
  return {
    name: "tgcc_log",
    label: "TGCC Log",
    description:
      "View the event log for a TGCC agent's CC session. " +
      "Shows build results, commits, milestones, errors, and assistant output. " +
      "Use to check what an agent is working on without waking it.",
    parameters: TgccLogParams as Record<string, unknown>,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const p = params as unknown as LogParams;
      const client = getClient();

      if (!client?.isConnected()) {
        return json({ error: "Not connected to TGCC" });
      }

      try {
        const result = await client.getLog(p.agentId, {
          offset: p.offset,
          limit: p.limit ?? 30,
          grep: p.grep,
          since: p.since,
          type: p.type,
        });
        return json(result);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
