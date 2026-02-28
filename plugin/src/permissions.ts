/**
 * Permission request handler — sends Telegram inline buttons for Allow/Deny.
 *
 * When TGCC reports a permission_request event, this module sends a Telegram
 * message with inline keyboard buttons. The callback_data uses the tgcc_perm:
 * prefix format that OpenClaw's Telegram handler can route back to us.
 */

import type { PluginLogger, PluginRuntime } from "openclaw/plugin-sdk";
import type { TgccPermissionRequestEvent, TgccSupervisorClient } from "./client.js";
import { removePendingPermission } from "./events.js";

// Max bytes for Telegram callback_data is 64. With prefix `tgcc_perm:a:` (12 chars),
// separator `:` (1 char), and UUID (36 chars), the agentId budget is 15 chars.
const AGENT_ID_MAX = 15;

function buildPermCallbackData(
  decision: "a" | "d",
  agentId: string,
  requestId: string,
): string {
  const safeId = agentId.length > AGENT_ID_MAX ? agentId.slice(0, AGENT_ID_MAX) : agentId;
  return `tgcc_perm:${decision}:${safeId}:${requestId}`;
}

/**
 * Send a Telegram message with Allow / Deny inline buttons for a permission request.
 */
export function handlePermissionRequest(
  event: TgccPermissionRequestEvent,
  runtime: PluginRuntime,
  telegramChatId: string | undefined,
  log: PluginLogger,
): void {
  if (!telegramChatId) {
    log.info("[tgcc] no telegramChatId configured, skipping permission buttons");
    return;
  }

  const { agentId, toolName, requestId, description } = event;

  const text = `🔒 <b>${agentId}</b> needs permission: <b>${toolName}</b>\n${description}`;
  const buttons = [
    [
      { text: "✅ Allow", callback_data: buildPermCallbackData("a", agentId, requestId) },
      { text: "❌ Deny", callback_data: buildPermCallbackData("d", agentId, requestId) },
    ],
  ];

  const sendMessageTelegram = runtime.channel?.telegram?.sendMessageTelegram;
  if (!sendMessageTelegram) {
    log.warn("[tgcc] runtime.channel.telegram.sendMessageTelegram not available");
    return;
  }

  void (sendMessageTelegram as (
    target: string | number,
    text: string,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>)(telegramChatId, text, {
    textMode: "html",
    buttons,
  }).catch((err: unknown) => {
    log.warn(
      `[tgcc] permission request telegram message failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

/**
 * Register a gateway method for programmatic permission responses.
 * Allows external systems to respond to permission requests without TG buttons.
 */
export function createPermissionResponseHandler(
  getClient: () => TgccSupervisorClient | null,
  log: PluginLogger,
) {
  return async (opts: { params: Record<string, unknown>; respond: (ok: boolean, payload?: unknown) => void }) => {
    const { params, respond } = opts;
    const agentId = typeof params.agentId === "string" ? params.agentId : "";
    const requestId = typeof params.requestId === "string" ? params.requestId : "";
    const decision = params.decision === "allow" ? "allow" : params.decision === "deny" ? "deny" : "";

    if (!agentId || !requestId || !decision) {
      respond(false, { error: "agentId, requestId, and decision (allow|deny) are required" });
      return;
    }

    const client = getClient();
    if (!client?.isConnected()) {
      respond(false, { error: "Not connected to TGCC" });
      return;
    }

    try {
      await client.respondToPermission(agentId, requestId, decision as "allow" | "deny");
      removePendingPermission(requestId);
      respond(true, { agentId, requestId, decision });
      log.info(`[tgcc] permission responded: ${agentId} ${requestId} → ${decision}`);
    } catch (err) {
      respond(false, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}
