/**
 * OpenClaw plugin entry point for the TGCC Bridge.
 *
 * Connects to TGCC's control socket as a supervisor, registers agent tools
 * (tgcc_spawn, tgcc_send, tgcc_status, tgcc_kill), and relays events.
 */

import path from "node:path";
import fs from "node:fs";
import type { OpenClawPluginApi, GatewayRequestHandlerOptions } from "openclaw/plugin-sdk";
import { TgccSupervisorClient } from "./src/client.js";
import { attachEventHandlers, setPermissionRequestHandler } from "./src/events.js";
import { createTgccSpawnTool } from "./src/tools/tgcc-spawn.js";
import { createTgccSendTool } from "./src/tools/tgcc-send.js";
import { createTgccStatusTool } from "./src/tools/tgcc-status.js";
import { createTgccKillTool } from "./src/tools/tgcc-kill.js";
import {
  handlePermissionRequest,
  createPermissionResponseHandler,
} from "./src/permissions.js";

// ---------------------------------------------------------------------------
// Plugin config parsing
// ---------------------------------------------------------------------------

interface TgccPluginConfig {
  enabled: boolean;
  socketDir: string;
  defaultAgent?: string;
  agents?: string[];
  telegramChatId?: string;
}

function parseConfig(raw: Record<string, unknown> | undefined): TgccPluginConfig {
  const obj = raw ?? {};
  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : true,
    socketDir: typeof obj.socketDir === "string" ? obj.socketDir : "/tmp/tgcc/ctl",
    defaultAgent: typeof obj.defaultAgent === "string" ? obj.defaultAgent : undefined,
    agents: Array.isArray(obj.agents) ? (obj.agents as string[]) : undefined,
    telegramChatId: typeof obj.telegramChatId === "string" ? obj.telegramChatId : undefined,
  };
}

// ---------------------------------------------------------------------------
// Socket discovery — find .sock files in the socket directory
// ---------------------------------------------------------------------------

function discoverSocket(socketDir: string): string | null {
  try {
    const files = fs.readdirSync(socketDir);
    const sock = files.find((f) => f.endsWith(".sock"));
    return sock ? path.join(socketDir, sock) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

const tgccPlugin = {
  id: "tgcc",
  name: "TGCC Bridge",
  description: "Bridge OpenClaw agents to Claude Code sessions via TGCC",
  configSchema: {
    parse(value: unknown): TgccPluginConfig {
      const raw =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      return parseConfig(raw);
    },
    uiHints: {
      socketDir: {
        label: "Socket Directory",
        help: "Directory containing TGCC control sockets (default: /tmp/tgcc/ctl)",
      },
      defaultAgent: {
        label: "Default Agent",
        help: "Default TGCC agent ID for spawns",
      },
      agents: { label: "Agent IDs" },
      telegramChatId: {
        label: "Telegram Chat ID",
        help: "Chat ID for permission request buttons",
      },
    },
  },

  register(api: OpenClawPluginApi) {
    const config = parseConfig(
      api.pluginConfig as Record<string, unknown> | undefined,
    );

    if (!config.enabled) {
      api.logger.info("[tgcc] plugin disabled");
      return;
    }

    const log = api.logger;
    let client: TgccSupervisorClient | null = null;

    const getClient = () => client;

    // ── Register tools ──────────────────────────────────────────────

    api.registerTool(createTgccSpawnTool(getClient, config.defaultAgent));
    api.registerTool(createTgccSendTool(getClient));
    api.registerTool(createTgccStatusTool(getClient));
    api.registerTool(createTgccKillTool(getClient));

    // ── Register gateway methods ────────────────────────────────────

    // Permission response gateway method
    api.registerGatewayMethod(
      "tgcc.permission_response",
      createPermissionResponseHandler(getClient, log) as (
        opts: GatewayRequestHandlerOptions,
      ) => Promise<void>,
    );

    // Status gateway method (for programmatic access)
    api.registerGatewayMethod("tgcc.status", async ({ params, respond }) => {
      const c = getClient();
      if (!c?.isConnected()) {
        respond(false, { error: "Not connected to TGCC" });
        return;
      }
      try {
        const agentId =
          typeof params.agentId === "string" ? params.agentId : undefined;
        const status = await c.getStatus(agentId);
        respond(true, status);
      } catch (err) {
        respond(false, { error: err instanceof Error ? err.message : String(err) });
      }
    });

    // Send message gateway method
    api.registerGatewayMethod("tgcc.send", async ({ params, respond }) => {
      const c = getClient();
      if (!c?.isConnected()) {
        respond(false, { error: "Not connected to TGCC" });
        return;
      }
      const agentId = typeof params.agentId === "string" ? params.agentId : "";
      const text = typeof params.text === "string" ? params.text : "";
      if (!agentId || !text) {
        respond(false, { error: "agentId and text are required" });
        return;
      }
      try {
        const result = await c.sendMessage(agentId, text, { subscribe: true });
        respond(true, result);
      } catch (err) {
        respond(false, { error: err instanceof Error ? err.message : String(err) });
      }
    });

    // ── Register background service ─────────────────────────────────

    api.registerService({
      id: "tgcc-supervisor",
      async start() {
        const socketPath = discoverSocket(config.socketDir);
        if (!socketPath) {
          log.info(
            `[tgcc] no socket found in ${config.socketDir}, will retry on reconnect`,
          );
        }

        const effectiveSocket = socketPath ?? path.join(config.socketDir, "tgcc.sock");

        client = new TgccSupervisorClient({
          socket: effectiveSocket,
          logger: log,
        });

        // Wire up event handlers
        attachEventHandlers(client, log);

        // Wire up permission request handler
        setPermissionRequestHandler((event) => {
          handlePermissionRequest(event, api.runtime, config.telegramChatId, log);
        });

        client.start();
        log.info(`[tgcc] supervisor service started (socket: ${effectiveSocket})`);
      },

      async stop() {
        if (client) {
          client.stop();
          client = null;
          log.info("[tgcc] supervisor service stopped");
        }
      },
    });
  },
};

export default tgccPlugin;
