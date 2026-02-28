/**
 * TgccSupervisorClient — Unix socket client for the TGCC Supervisor Protocol.
 *
 * Connects to TGCC's ctl socket, registers as a supervisor, and provides
 * async methods for interacting with TGCC-managed agents and CC processes.
 *
 * Adapted from the OpenClaw fork (src/agents/tgcc-supervisor/client.ts)
 * to use only the plugin API — no OpenClaw internal imports.
 */

import crypto from "node:crypto";
import { exec as cpExec } from "node:child_process";
import net from "node:net";
import { EventEmitter } from "node:events";
import type { PluginLogger } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Wire protocol types
// ---------------------------------------------------------------------------

export interface SupervisorCommand {
  type: "command";
  requestId: string;
  action: string;
  params?: Record<string, unknown>;
}

export interface SupervisorResponse {
  type: "response";
  requestId: string;
  result?: unknown;
  error?: string;
}

export interface SupervisorEvent {
  type: "event";
  event: string;
  [key: string]: unknown;
}

type WireMessage = SupervisorCommand | SupervisorResponse | SupervisorEvent;

// ---------------------------------------------------------------------------
// Status response types
// ---------------------------------------------------------------------------

export interface TgccAgentStatus {
  id: string;
  type: "persistent" | "ephemeral";
  state: "idle" | "active";
  sessionId: string | null;
  repo: string;
  supervisorSubscribed: boolean;
}

export interface TgccStatusResult {
  agents: TgccAgentStatus[];
  sessions?: Array<{
    id: string;
    agentId: string;
    messageCount?: number;
    totalCostUsd?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Event types emitted by the client
// ---------------------------------------------------------------------------

export interface TgccResultEvent {
  agentId: string;
  sessionId: string;
  text: string;
  cost_usd?: number;
  duration_ms?: number;
  is_error?: boolean;
}

export interface TgccProcessExitEvent {
  agentId: string;
  sessionId: string;
  exitCode: number | null;
}

export interface TgccSessionTakeoverEvent {
  agentId: string;
  sessionId: string;
  exitCode: number | null;
}

export interface TgccApiErrorEvent {
  agentId: string;
  sessionId: string;
  message: string;
}

export interface TgccPermissionRequestEvent {
  agentId: string;
  toolName: string;
  requestId: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TgccSupervisorClientConfig {
  socket: string;
  logger: PluginLogger;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  heartbeatMs?: number;
}

// ---------------------------------------------------------------------------
// Pending request tracking
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const HEARTBEAT_PONG_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Safety patterns for reverse-exec
// ---------------------------------------------------------------------------

const EXEC_DENY_PATTERNS = [
  /rm\s+(-[a-z]*f[a-z]*\s+)?\//i,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\b.*\bof=\//,
  /:\(\)\{/,
  /\bchmod\s+777\s+\//,
  /\bchown\b.*\//,
  /\|\s*sh\b/,
  /\$\(/,
  /`[^`]*`/,
];

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class TgccSupervisorClient extends EventEmitter {
  private log: PluginLogger;
  private socketPath: string;
  private socket: net.Socket | null = null;
  private connected = false;
  private destroyed = false;
  private reconnectDelay: number;
  private reconnectInitialMs: number;
  private reconnectMaxMs: number;
  private heartbeatMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private lineBuffer = "";

  constructor(config: TgccSupervisorClientConfig) {
    super();
    this.log = config.logger;
    this.socketPath = config.socket;
    this.reconnectInitialMs = config.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
    this.reconnectMaxMs = config.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.heartbeatMs = config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.reconnectDelay = this.reconnectInitialMs;
  }

  // ── Public lifecycle ─────────────────────────────────────────────────

  start(): void {
    if (this.destroyed) return;
    this.connect();
  }

  stop(): void {
    this.destroyed = true;
    this.clearTimers();
    this.rejectAllPending("Client stopped");
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ── Public API methods ───────────────────────────────────────────────

  async sendMessage(
    agentId: string,
    text: string,
    opts?: { sessionId?: string; subscribe?: boolean },
  ): Promise<{ sessionId: string; state: string; subscribed?: boolean }> {
    return (await this.sendCommand("send_message", {
      agentId,
      text,
      sessionId: opts?.sessionId,
      subscribe: opts?.subscribe ?? true,
    })) as { sessionId: string; state: string; subscribed?: boolean };
  }

  async sendToCC(agentId: string, text: string): Promise<{ sent: boolean }> {
    return (await this.sendCommand("send_to_cc", { agentId, text })) as { sent: boolean };
  }

  async getStatus(agentId?: string): Promise<TgccStatusResult> {
    const params: Record<string, unknown> = {};
    if (agentId) params.agentId = agentId;
    return (await this.sendCommand("status", params)) as TgccStatusResult;
  }

  async killCC(agentId: string): Promise<unknown> {
    return this.sendCommand("kill_cc", { agentId });
  }

  async subscribe(agentId: string, sessionId?: string): Promise<unknown> {
    const params: Record<string, unknown> = { agentId };
    if (sessionId) params.sessionId = sessionId;
    return this.sendCommand("subscribe", params);
  }

  async unsubscribe(agentId: string): Promise<unknown> {
    return this.sendCommand("unsubscribe", { agentId });
  }

  async respondToPermission(
    agentId: string,
    permissionRequestId: string,
    decision: "allow" | "deny",
  ): Promise<unknown> {
    return this.sendCommand("permission_response", { agentId, permissionRequestId, decision });
  }

  async createAgent(params: {
    agentId?: string;
    repo: string;
    model?: string;
    permissionMode?: string;
    timeoutMs?: number;
  }): Promise<{ agentId: string; state: string }> {
    return (await this.sendCommand("create_agent", {
      agentId: params.agentId,
      repo: params.repo,
      model: params.model,
      permissionMode: params.permissionMode,
      timeoutMs: params.timeoutMs,
    })) as { agentId: string; state: string };
  }

  async destroyAgent(agentId: string): Promise<{ destroyed: boolean }> {
    return (await this.sendCommand("destroy_agent", { agentId })) as { destroyed: boolean };
  }

  async getLog(
    agentId: string,
    opts?: { offset?: number; limit?: number; grep?: string; since?: number; type?: string },
  ): Promise<{
    totalLines: number;
    returnedLines: number;
    offset: number;
    lines: Array<{ ts: number; type: string; text: string }>;
  }> {
    const params: Record<string, unknown> = { agentId };
    if (opts?.offset != null) params.offset = opts.offset;
    if (opts?.limit != null) params.limit = opts.limit;
    if (opts?.grep) params.grep = opts.grep;
    if (opts?.since != null) params.since = opts.since;
    if (opts?.type) params.type = opts.type;
    return (await this.sendCommand("get_log", params)) as {
      totalLines: number;
      returnedLines: number;
      offset: number;
      lines: Array<{ ts: number; type: string; text: string }>;
    };
  }

  // ── Connection management ────────────────────────────────────────────

  private connect(): void {
    if (this.destroyed) return;

    this.log.info(`[tgcc] connecting to ctl socket: ${this.socketPath}`);

    const sock = net.createConnection({ path: this.socketPath });
    this.socket = sock;

    sock.on("connect", () => {
      this.log.info("[tgcc] connected to ctl socket");
      this.connected = true;
      this.reconnectDelay = this.reconnectInitialMs;
      this.lineBuffer = "";
      this.register();
      this.startHeartbeat();
      this.emit("connected");
    });

    sock.on("data", (data: Buffer) => {
      this.handleData(data);
    });

    sock.on("error", (err: Error) => {
      this.log.warn(`[tgcc] socket error: ${err.message}`);
    });

    sock.on("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.clearTimers();
      this.socket = null;
      if (wasConnected) {
        this.log.info("[tgcc] socket closed, scheduling reconnect");
        this.emit("disconnected");
      } else {
        this.emit("connectFailed");
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer) return;

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxMs);

    this.log.info(`[tgcc] reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private register(): void {
    this.sendRaw({
      type: "register_supervisor",
      agentId: "openclaw",
      capabilities: ["exec", "notify"],
    } as unknown as Record<string, unknown>);
  }

  // ── Heartbeat ────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendPing();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private sendPing(): void {
    if (!this.connected) return;

    const requestId = crypto.randomUUID();
    this.sendRaw({
      type: "command",
      requestId,
      action: "ping",
    });

    this.pongTimer = setTimeout(() => {
      this.log.warn("[tgcc] pong timeout, forcing reconnect");
      this.forceReconnect();
    }, HEARTBEAT_PONG_TIMEOUT_MS);
    this.pongTimer.unref?.();

    this.pendingRequests.set(requestId, {
      resolve: () => {
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
      },
      reject: () => {},
      timer: setTimeout(() => {
        this.pendingRequests.delete(requestId);
      }, HEARTBEAT_PONG_TIMEOUT_MS + 1_000),
    });
    this.pendingRequests.get(requestId)!.timer.unref?.();
  }

  private forceReconnect(): void {
    this.rejectAllPending("Connection lost");
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.clearTimers();
    this.scheduleReconnect();
  }

  // ── Data parsing ─────────────────────────────────────────────────────

  private handleData(data: Buffer): void {
    this.lineBuffer += data.toString("utf-8");
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as WireMessage;
        this.handleMessage(msg);
      } catch {
        this.log.warn(`[tgcc] failed to parse message: ${trimmed.slice(0, 200)}`);
      }
    }
  }

  private handleMessage(msg: WireMessage): void {
    if (msg.type === "response") {
      this.handleResponse(msg);
    } else if (msg.type === "event") {
      this.handleEvent(msg);
    } else if (msg.type === "command") {
      void this.handleReverseCommand(msg);
    }
  }

  private handleResponse(msg: SupervisorResponse): void {
    const pending = this.pendingRequests.get(msg.requestId);
    if (!pending) return;

    this.pendingRequests.delete(msg.requestId);
    clearTimeout(pending.timer);

    if (msg.error) {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleEvent(msg: SupervisorEvent): void {
    const eventName = msg.event;
    this.log.info(`[tgcc] event: ${String(eventName)} agentId=${String(msg.agentId ?? "?")}`);

    switch (eventName) {
      case "result":
        this.emit("tgcc:result", {
          agentId: msg.agentId,
          sessionId: msg.sessionId,
          text: msg.text,
          cost_usd: msg.cost_usd,
          duration_ms: msg.duration_ms,
          is_error: msg.is_error,
        } as TgccResultEvent);
        break;

      case "process_exit":
        this.emit("tgcc:process_exit", {
          agentId: msg.agentId,
          sessionId: msg.sessionId,
          exitCode: msg.exitCode ?? null,
        } as TgccProcessExitEvent);
        break;

      case "session_takeover":
        this.emit("tgcc:session_takeover", {
          agentId: msg.agentId,
          sessionId: msg.sessionId,
          exitCode: msg.exitCode ?? null,
        } as TgccSessionTakeoverEvent);
        break;

      case "api_error":
        this.emit("tgcc:api_error", {
          agentId: msg.agentId,
          sessionId: msg.sessionId,
          message: msg.message,
        } as TgccApiErrorEvent);
        break;

      case "permission_request":
        this.emit("tgcc:permission_request", {
          agentId: msg.agentId,
          toolName: msg.toolName,
          requestId: msg.requestId,
          description: msg.description,
        } as TgccPermissionRequestEvent);
        break;

      case "registered":
        this.log.info("[tgcc] supervisor registered");
        this.emit("registered");
        void this.syncStateAfterConnect();
        break;

      case "bridge_started":
      case "cc_spawned":
      case "agent_created":
      case "agent_destroyed":
      case "state_changed":
      case "build_result":
      case "git_commit":
      case "context_pressure":
      case "failure_loop":
      case "stuck":
      case "task_milestone":
      case "cc_message":
      case "subagent_spawn":
      case "budget_alert":
        this.emit(`tgcc:${eventName}`, msg);
        break;

      default:
        this.emit(`tgcc:${eventName}`, msg);
        break;
    }
  }

  private async syncStateAfterConnect(): Promise<void> {
    try {
      const status = await this.getStatus();
      this.emit("tgcc:status_sync", status);
    } catch (err) {
      this.log.warn(
        `[tgcc] failed to sync state after connect: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Reverse command handling (TGCC → OpenClaw) ───────────────────────

  private async handleReverseCommand(msg: SupervisorCommand): Promise<void> {
    const { requestId, action, params } = msg;
    this.log.info(`[tgcc] reverse command: ${action} (requestId=${requestId})`);

    try {
      switch (action) {
        case "exec":
          await this.handleExecCommand(requestId, params ?? {});
          break;
        case "restart_service":
          await this.handleRestartServiceCommand(requestId, params ?? {});
          break;
        case "notify":
          this.handleNotifyCommand(requestId, params ?? {});
          break;
        default:
          this.sendResponse(requestId, undefined, `Unknown reverse command: ${action}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log.warn(`[tgcc] reverse command ${action} failed: ${errMsg}`);
      this.sendResponse(requestId, undefined, errMsg);
    }
  }

  private async handleExecCommand(
    requestId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const command = typeof params.command === "string" ? params.command : "";
    const agentId = typeof params.agentId === "string" ? params.agentId : "unknown";
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 60_000;

    if (!command.trim()) {
      this.sendResponse(requestId, undefined, "Empty command");
      return;
    }

    for (const pattern of EXEC_DENY_PATTERNS) {
      if (pattern.test(command)) {
        this.log.warn(`[tgcc] reverse exec DENIED (agent=${agentId}): ${command}`);
        this.sendResponse(
          requestId,
          undefined,
          `Command denied by safety gate: ${command.slice(0, 100)}`,
        );
        return;
      }
    }

    this.log.info(`[tgcc] reverse exec (agent=${agentId}): ${command.slice(0, 200)}`);

    return new Promise<void>((resolve) => {
      cpExec(
        command,
        {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          cwd: typeof params.cwd === "string" ? params.cwd : undefined,
        },
        (err, stdout, stderr) => {
          const exitCode =
            err && "code" in err ? ((err as { code?: number }).code ?? 1) : err ? 1 : 0;
          this.sendResponse(requestId, {
            exitCode,
            stdout: stdout.slice(0, 50_000),
            stderr: stderr.slice(0, 50_000),
          });
          resolve();
        },
      );
    });
  }

  private async handleRestartServiceCommand(
    requestId: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const service = typeof params.service === "string" ? params.service : "";
    const agentId = typeof params.agentId === "string" ? params.agentId : "unknown";

    this.log.info(`[tgcc] reverse restart_service (agent=${agentId}, service=${service})`);

    if (service === "tgcc") {
      return new Promise<void>((resolve) => {
        cpExec(
          `tmux send-keys -t tgcc C-c '' Enter; sleep 1; tmux send-keys -t tgcc 'cd ~/Botverse/tgcc && node dist/cli.js run' Enter`,
          { timeout: 15_000 },
          (err) => {
            if (err) {
              this.sendResponse(requestId, undefined, `Failed to restart tgcc: ${err.message}`);
            } else {
              this.sendResponse(requestId, { restarted: true, service });
            }
            resolve();
          },
        );
      });
    }

    this.sendResponse(requestId, undefined, `Unknown service: ${service}`);
  }

  private handleNotifyCommand(requestId: string, params: Record<string, unknown>): void {
    const message = typeof params.message === "string" ? params.message : "";
    const target = typeof params.target === "string" ? params.target : "";

    if (!message.trim()) {
      this.sendResponse(requestId, undefined, "Empty notification message");
      return;
    }

    this.emit("tgcc:reverse_notify", { target, message });
    this.sendResponse(requestId, { notified: true });
  }

  private sendResponse(requestId: string, result?: unknown, error?: string): void {
    this.sendRaw({
      type: "response",
      requestId,
      ...(error ? { error } : { result }),
    });
  }

  // ── Command sending ──────────────────────────────────────────────────

  private sendCommand(action: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        reject(new Error("Not connected to TGCC"));
        return;
      }

      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`TGCC command timeout: ${action}`));
      }, COMMAND_TIMEOUT_MS);
      timer.unref?.();

      this.pendingRequests.set(requestId, { resolve, reject, timer });

      this.sendRaw({
        type: "command",
        requestId,
        action,
        params,
      });
    });
  }

  private sendRaw(msg: Record<string, unknown>): void {
    if (!this.socket || this.socket.destroyed) return;
    try {
      this.socket.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      this.log.warn(
        `[tgcc] failed to send: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Timer management ─────────────────────────────────────────────────

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }
}
