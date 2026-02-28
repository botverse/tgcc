/**
 * tgcc_status tool — Get status of TGCC agents and sessions.
 *
 * Returns agent states, pending results, pending permissions,
 * and recent observability events.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { TgccSupervisorClient } from "../client.js";
import {
  getAgentCache,
  getPendingResults,
  drainPendingResults,
  getPendingPermissions,
  getRecentEvents,
} from "../events.js";

const TgccStatusParams = Type.Object({
  agentId: Type.Optional(Type.String({ description: "Filter by specific agent ID" })),
  drain: Type.Optional(
    Type.Boolean({
      description: "If true, drain pending results (remove after reading). Default: false.",
    }),
  ),
  eventsSince: Type.Optional(
    Type.Number({ description: "Only return events after this Unix timestamp (ms)" }),
  ),
});

type StatusParams = Static<typeof TgccStatusParams>;

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

export function createTgccStatusTool(
  getClient: () => TgccSupervisorClient | null,
): AnyAgentTool {
  return {
    name: "tgcc_status",
    label: "TGCC Status",
    description:
      "Get the status of TGCC agents and sessions. Shows agent states, " +
      "pending results from completed CC sessions, pending permission requests, " +
      "and recent observability events. Use drain=true to consume pending results.",
    parameters: TgccStatusParams,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const p = params as unknown as StatusParams;
      const client = getClient();
      const connected = client?.isConnected() ?? false;

      // Get cached agent state
      const cache = getAgentCache();

      // Get pending data
      const results = p.drain ? drainPendingResults() : getPendingResults();
      const permissions = getPendingPermissions();
      const events = getRecentEvents(p.eventsSince);

      // Filter by agentId if specified
      const filterAgent = (items: Array<{ agentId?: string }>) =>
        p.agentId ? items.filter((i) => i.agentId === p.agentId) : items;

      // Optionally fetch live status from TGCC
      let liveStatus: unknown = null;
      if (connected && client) {
        try {
          liveStatus = await client.getStatus(p.agentId);
        } catch {
          // Fall back to cached data
        }
      }

      return json({
        connected,
        agents: p.agentId
          ? cache[p.agentId]
            ? { [p.agentId]: cache[p.agentId] }
            : {}
          : cache,
        liveStatus,
        pendingResults: filterAgent(results),
        pendingPermissions: filterAgent(permissions),
        recentEvents: filterAgent(events),
      });
    },
  };
}
