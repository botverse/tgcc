/**
 * Event handlers for TGCC supervisor events.
 *
 * Manages agent state cache and stores pending results/events
 * for retrieval via tools and gateway methods.
 */

import type { PluginLogger } from "openclaw/plugin-sdk";
import type {
  TgccSupervisorClient,
  TgccResultEvent,
  TgccProcessExitEvent,
  TgccApiErrorEvent,
  TgccPermissionRequestEvent,
  TgccStatusResult,
} from "./client.js";

// ---------------------------------------------------------------------------
// Agent cache
// ---------------------------------------------------------------------------

export interface TgccAgentMapping {
  repo: string;
  type?: "persistent" | "ephemeral";
  state?: "idle" | "active";
}

let agentCache: Record<string, TgccAgentMapping> = {};

export function getAgentCache(): Record<string, TgccAgentMapping> {
  return agentCache;
}

// ---------------------------------------------------------------------------
// Pending results ring buffer
// ---------------------------------------------------------------------------

export interface PendingResult {
  agentId: string;
  sessionId: string;
  text: string;
  cost_usd?: number;
  duration_ms?: number;
  is_error?: boolean;
  receivedAt: number;
}

const MAX_PENDING_RESULTS = 50;
const pendingResults: PendingResult[] = [];

export function getPendingResults(): PendingResult[] {
  return pendingResults;
}

export function drainPendingResults(): PendingResult[] {
  return pendingResults.splice(0);
}

// ---------------------------------------------------------------------------
// Pending permission requests
// ---------------------------------------------------------------------------

export interface PendingPermission {
  agentId: string;
  toolName: string;
  requestId: string;
  description: string;
  receivedAt: number;
}

const pendingPermissions: PendingPermission[] = [];

export function getPendingPermissions(): PendingPermission[] {
  return pendingPermissions;
}

export function removePendingPermission(requestId: string): void {
  const idx = pendingPermissions.findIndex((p) => p.requestId === requestId);
  if (idx >= 0) pendingPermissions.splice(idx, 1);
}

// ---------------------------------------------------------------------------
// Recent events log (ring buffer)
// ---------------------------------------------------------------------------

export interface RecentEvent {
  event: string;
  agentId?: string;
  summary: string;
  ts: number;
}

const MAX_RECENT_EVENTS = 100;
const recentEvents: RecentEvent[] = [];

export function getRecentEvents(since?: number): RecentEvent[] {
  if (since) return recentEvents.filter((e) => e.ts > since);
  return recentEvents;
}

function pushRecentEvent(event: string, agentId: string | undefined, summary: string): void {
  recentEvents.push({ event, agentId, summary, ts: Date.now() });
  if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift();
}

// ---------------------------------------------------------------------------
// Observability event formatting
// ---------------------------------------------------------------------------

function formatObservabilityMessage(event: Record<string, unknown>): string | null {
  const agentId = String(event.agentId ?? "unknown");
  const prefix = `[${agentId}]`;
  const eventName = String(event.event ?? "");

  switch (eventName) {
    case "build_result": {
      const passed = event.passed === true;
      if (passed) return `${prefix} Build passed`;
      const errors = typeof event.errors === "number" ? event.errors : "?";
      const summary = typeof event.summary === "string" ? `: ${event.summary}` : "";
      return `${prefix} Build failed: ${errors} errors${summary}`;
    }
    case "git_commit": {
      const msg = typeof event.message === "string" ? event.message : "?";
      return `${prefix} Committed: "${msg}"`;
    }
    case "context_pressure": {
      const pct = typeof event.percent === "number" ? event.percent : "?";
      return `${prefix} Context at ${pct}%`;
    }
    case "failure_loop": {
      const n = typeof event.consecutiveFailures === "number" ? event.consecutiveFailures : "?";
      return `${prefix} ${n} consecutive failures`;
    }
    case "stuck": {
      const mins = typeof event.silentMs === "number" ? Math.round(event.silentMs / 60_000) : "?";
      return `${prefix} No progress for ${mins}m`;
    }
    case "task_milestone": {
      const task = typeof event.task === "string" ? event.task : "?";
      const progress = typeof event.progress === "string" ? `[${event.progress}] ` : "";
      return `${prefix} ${progress}${task}`;
    }
    case "cc_message": {
      const text = typeof event.text === "string" ? event.text : "?";
      return `${prefix} "${text}"`;
    }
    case "subagent_spawn": {
      const count = typeof event.count === "number" ? event.count : "?";
      return `${prefix} Spawned ${count} sub-agents`;
    }
    case "budget_alert": {
      const cost = typeof event.costUsd === "number" ? `$${event.costUsd.toFixed(2)}` : "$?";
      const budget = typeof event.budgetUsd === "number" ? `$${event.budgetUsd.toFixed(2)}` : "$?";
      return `${prefix} ${cost} spent (budget: ${budget})`;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Permission request handler (calls onPermissionRequest callback)
// ---------------------------------------------------------------------------

export type PermissionRequestHandler = (event: TgccPermissionRequestEvent) => void;

let permissionRequestHandler: PermissionRequestHandler | null = null;

export function setPermissionRequestHandler(handler: PermissionRequestHandler): void {
  permissionRequestHandler = handler;
}

// ---------------------------------------------------------------------------
// Attach event handlers to the client
// ---------------------------------------------------------------------------

export function attachEventHandlers(client: TgccSupervisorClient, log: PluginLogger): void {
  client.on("connected", () => void refreshAgentCache(client, log));

  client.on("tgcc:result", (event: TgccResultEvent) => {
    log.info(
      `[tgcc] result from ${event.agentId} (${event.is_error ? "error" : "ok"}, cost=$${event.cost_usd?.toFixed(4) ?? "?"})`,
    );
    pendingResults.push({ ...event, receivedAt: Date.now() });
    if (pendingResults.length > MAX_PENDING_RESULTS) pendingResults.shift();
    pushRecentEvent("result", event.agentId, event.is_error ? "error" : "ok");
  });

  client.on("tgcc:process_exit", (event: TgccProcessExitEvent) => {
    log.info(`[tgcc] process_exit from ${event.agentId} (exit=${event.exitCode})`);
    pushRecentEvent("process_exit", event.agentId, `exit=${event.exitCode}`);
  });

  client.on("tgcc:session_takeover", () => {
    // Session taken over by another client — logged, no action needed
  });

  client.on("tgcc:api_error", (event: TgccApiErrorEvent) => {
    log.warn(`[tgcc] api_error from ${event.agentId}: ${event.message}`);
    pushRecentEvent("api_error", event.agentId, event.message);
  });

  client.on("tgcc:permission_request", (event: TgccPermissionRequestEvent) => {
    log.info(
      `[tgcc] permission_request: agent=${event.agentId} tool=${event.toolName} requestId=${event.requestId}`,
    );
    pendingPermissions.push({ ...event, receivedAt: Date.now() });
    pushRecentEvent("permission_request", event.agentId, `${event.toolName}: ${event.description}`);
    permissionRequestHandler?.(event);
  });

  // Lifecycle events
  client.on("tgcc:bridge_started", () => void refreshAgentCache(client, log));

  client.on("tgcc:cc_spawned", (event: Record<string, unknown>) => {
    const agentId = String(event.agentId ?? "");
    if (agentId && agentCache[agentId]) {
      agentCache[agentId].state = "active";
    }
    pushRecentEvent("cc_spawned", agentId, "");
  });

  client.on("tgcc:agent_created", (event: Record<string, unknown>) => {
    const agentId = String(event.agentId ?? "");
    const repo = String(event.repo ?? "");
    const type = String(event.type ?? "ephemeral") as "persistent" | "ephemeral";
    if (agentId) {
      agentCache[agentId] = { repo, type, state: "idle" };
    }
    pushRecentEvent("agent_created", agentId, `type=${type}`);
  });

  client.on("tgcc:agent_destroyed", (event: Record<string, unknown>) => {
    const agentId = String(event.agentId ?? "");
    if (agentId) delete agentCache[agentId];
    pushRecentEvent("agent_destroyed", agentId, "");
  });

  client.on("tgcc:state_changed", (event: Record<string, unknown>) => {
    const agentId = String(event.agentId ?? "");
    const field = String(event.field ?? "");
    const newValue = event.newValue;
    if (agentId && agentCache[agentId]) {
      if (field === "state" && (newValue === "idle" || newValue === "active")) {
        agentCache[agentId].state = newValue;
      } else if (field === "repo" && typeof newValue === "string") {
        agentCache[agentId].repo = newValue;
      }
    }
  });

  // Observability events
  const observabilityEvents = [
    "tgcc:build_result",
    "tgcc:git_commit",
    "tgcc:context_pressure",
    "tgcc:failure_loop",
    "tgcc:stuck",
    "tgcc:task_milestone",
    "tgcc:cc_message",
    "tgcc:subagent_spawn",
    "tgcc:budget_alert",
  ];
  for (const evt of observabilityEvents) {
    client.on(evt, (event: Record<string, unknown>) => {
      const message = formatObservabilityMessage(event);
      if (message) {
        log.info(`[tgcc] observability: ${message}`);
        pushRecentEvent(
          String(event.event ?? evt.replace("tgcc:", "")),
          String(event.agentId ?? ""),
          message,
        );
      }
    });
  }

  // Reverse notify
  client.on("tgcc:reverse_notify", (event: { target: string; message: string }) => {
    log.info(`[tgcc] reverse notify to ${event.target}: ${event.message.slice(0, 200)}`);
    pushRecentEvent("reverse_notify", undefined, event.message.slice(0, 100));
  });

  // Status sync
  client.on("tgcc:status_sync", (status: TgccStatusResult) => {
    const fresh: Record<string, TgccAgentMapping> = {};
    for (const agent of status.agents) {
      fresh[agent.id] = { repo: agent.repo, type: agent.type, state: agent.state };
    }
    agentCache = fresh;
    log.info(`[tgcc] agent cache synced: ${status.agents.map((a) => a.id).join(", ")}`);
  });
}

async function refreshAgentCache(
  client: TgccSupervisorClient,
  log: PluginLogger,
): Promise<void> {
  if (!client.isConnected()) return;
  try {
    const result = await client.getStatus();
    const fresh: Record<string, TgccAgentMapping> = {};
    for (const agent of result.agents) {
      fresh[agent.id] = { repo: agent.repo, type: agent.type, state: agent.state };
    }
    agentCache = fresh;
    log.info(`[tgcc] agent cache refreshed: ${result.agents.map((a) => a.id).join(", ")}`);
  } catch (err) {
    log.warn(
      `[tgcc] failed to refresh agent cache: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
