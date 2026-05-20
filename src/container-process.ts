/**
 * ContainerCCProcess — Connects to a tgcc-relay inside a Docker container
 * via Unix domain socket. Implements the same event interface as CCProcess
 * so Bridge.ts doesn't need to distinguish between local and container CC.
 */

import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import type pino from 'pino';
import {
  type CCOutputEvent,
  type UserMessage,
  type StreamInnerEvent,
  type ApiErrorEvent,
  type TaskStartedEvent,
  type TaskProgressEvent,
  type TaskCompletedEvent,
  type CompactBoundaryEvent,
  type PermissionRequest,
  type ResultEvent,
  parseCCOutputLine,
  createToolResultMessage,
  createInitializeRequest,
  createPermissionResponse,
} from './cc-protocol.js';
import type { CCUserConfig, ProcessState, CCActivityState, ICCProcess } from './cc-process.js';

// ── Noop logger ──

const noopFn = () => {};
const noopLogger = {
  info: noopFn, warn: noopFn, error: noopFn, debug: noopFn, trace: noopFn, fatal: noopFn,
  child: () => noopLogger,
};

// ── Relay protocol messages ──

interface RelaySpawnMsg { type: 'spawn'; args: string[]; }
interface RelayMessageMsg { type: 'message'; content: unknown; }
interface RelayKillMsg { type: 'kill'; }
interface RelayCancelMsg { type: 'cancel'; }
interface RelayToolResultMsg { type: 'tool_result'; tool_use_id: string; content: string; }
interface RelayPermissionMsg { type: 'permission_response'; request_id: string; allowed: boolean; }
interface RelayPingMsg { type: 'ping'; }

type RelayOutbound =
  | RelaySpawnMsg | RelayMessageMsg | RelayKillMsg | RelayCancelMsg
  | RelayToolResultMsg | RelayPermissionMsg | RelayPingMsg;

interface RelaySpawnedMsg { type: 'spawned'; pid: number; }
interface RelayStreamMsg { type: 'stream'; event: unknown; }
interface RelayExitedMsg { type: 'exited'; code: number | null; signal: string | null; }
interface RelayErrorMsg { type: 'error'; message: string; }
interface RelayPongMsg { type: 'pong'; pid: number | null; }

type RelayInbound =
  | RelaySpawnedMsg | RelayStreamMsg | RelayExitedMsg
  | RelayErrorMsg | RelayPongMsg;

// ── Options ──

export interface ContainerCCProcessOptions {
  agentId: string;
  userId: string;
  /** Telegram chat this CC process belongs to (one CC process per chat per agent). */
  chatId: number;
  socketPath: string;
  userConfig: CCUserConfig;
  mcpConfigPath?: string;
  sessionId?: string;
  continueSession: boolean;
  logger?: pino.Logger;
  claudeConfigDir?: string;
}

// ── ContainerCCProcess ──

export class ContainerCCProcess extends EventEmitter implements ICCProcess {
  readonly agentId: string;
  readonly userId: string;
  readonly chatId: number;

  private socket: Socket | null = null;
  private _state: ProcessState = 'idle';
  private _ccActivity: CCActivityState = 'idle';
  private _sessionId: string | null = null;
  private _totalCostUsd = 0;
  private _spawnedAt: Date | null = null;
  private _killedByUs = false;
  private _takenOver = false;
  private _stateBeforeExit: ProcessState = 'idle';
  private _activityBeforeExit: CCActivityState = 'idle';
  private _killedBeforeExit = false;
  private _hadResult = false;
  private _pid: number | undefined;
  private _activeBackgroundTasks = new Set<string>();

  private messageQueue: UserMessage[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private hangTimer: ReturnType<typeof setTimeout> | null = null;
  private forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  private logger: pino.Logger;
  private options: ContainerCCProcessOptions;

  constructor(options: ContainerCCProcessOptions) {
    super();
    this.agentId = options.agentId;
    this.userId = options.userId;
    this.chatId = options.chatId;
    this.options = options;
    this.logger = options.logger
      ? options.logger.child({ agentId: options.agentId, userId: options.userId, container: true })
      : noopLogger as unknown as pino.Logger;
  }

  // ── Getters (same API as CCProcess) ──

  get state(): ProcessState { return this._state; }
  get ccActivity(): CCActivityState { return this._ccActivity; }
  get sessionId(): string | null { return this._sessionId; }
  get totalCostUsd(): number { return this._totalCostUsd; }
  get spawnedAt(): Date | null { return this._spawnedAt; }
  get pid(): number | undefined { return this._pid; }
  get hasBackgroundTasks(): boolean { return this._activeBackgroundTasks.size > 0; }
  get takenOver(): boolean { return this._takenOver; }
  get stateBeforeExit(): ProcessState { return this._stateBeforeExit; }
  get activityBeforeExit(): CCActivityState { return this._activityBeforeExit; }
  get killedBeforeExit(): boolean { return this._killedBeforeExit; }

  // ── Start: connect to relay and spawn CC ──

  async start(): Promise<void> {
    if (this._state !== 'idle') {
      this.logger.warn({ state: this._state }, 'Cannot start — not idle');
      return;
    }

    this._state = 'spawning';
    this.emit('stateChange', 'spawning');

    // Connect to relay socket with retries (container may still be starting)
    const maxRetries = 10;
    const retryDelayMs = 500;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      this.socket = connect(this.options.socketPath);
      try {
        await new Promise<void>((resolve, reject) => {
          this.socket!.once('connect', () => {
            this.logger.info({ socketPath: this.options.socketPath }, 'Connected to relay');
            resolve();
          });
          this.socket!.once('error', reject);
        });
        break; // connected
      } catch (err) {
        this.socket.removeAllListeners();
        this.socket.destroy();
        this.socket = null;
        if (attempt === maxRetries) throw err;
        this.logger.info({ attempt, maxRetries }, 'Relay not ready, retrying...');
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }

    // Now that we're connected, attach permanent handlers
    this.socket!.on('error', (err) => {
      this.logger.error({ err }, 'Relay socket error');
      this.emit('error', err);
      this.handleExit(1, null);
    });

    this.socket!.on('close', () => {
      this.logger.info('Relay socket closed');
      if (this._state !== 'idle') {
        this.handleExit(null, null);
      }
    });

    // Parse relay responses
    const rl = createInterface({ input: this.socket! });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as RelayInbound;
        this.handleRelayMessage(msg);
      } catch (err) {
        this.logger.error({ err, line: line.slice(0, 200) }, 'Invalid relay message');
      }
    });

    // Build CC args and tell the relay to spawn
    const args = this.buildArgs();
    this.logger.info({ args }, 'Requesting CC spawn via relay');
    this.sendToRelay({ type: 'spawn', args });
    this._spawnedAt = new Date();
  }

  // ── Build CC CLI arguments ──

  private buildArgs(): string[] {
    const cfg = this.options.userConfig;
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
    ];

    switch (cfg.permissionMode) {
      case 'dangerously-skip':
        args.push('--dangerously-skip-permissions');
        break;
      case 'acceptEdits':
        args.push('--permission-mode', 'acceptEdits');
        break;
      case 'plan':
        args.push('--permission-mode', 'plan');
        break;
    }

    if (cfg.model) {
      args.push('--model', cfg.model);
    }

    if (this.options.continueSession && this.options.sessionId) {
      args.push('--resume', this.options.sessionId);
    } else if (this.options.continueSession) {
      args.push('--continue');
    }

    if (this.options.mcpConfigPath) {
      args.push('--mcp-config', this.options.mcpConfigPath);
    }

    return args;
  }

  // ── Handle relay messages ──

  private handleRelayMessage(msg: RelayInbound): void {
    switch (msg.type) {
      case 'spawned':
        this._pid = msg.pid;
        this._state = 'spawning';
        this.emit('stateChange', 'spawning');
        this.logger.info({ pid: msg.pid }, 'CC spawned in container');
        // Send initialize handshake
        this.sendToRelay({
          type: 'message',
          content: createInitializeRequest(),
        });
        break;

      case 'stream':
        this.handleCCEvent(msg.event);
        break;

      case 'exited':
        this.logger.info({ code: msg.code, signal: msg.signal }, 'CC exited in container');
        this.handleExit(msg.code, msg.signal);
        break;

      case 'error':
        this.logger.error({ message: msg.message }, 'Relay error');
        break;

      case 'pong':
        // Health check response
        break;
    }
  }

  // ── Handle CC output events (same logic as CCProcess.handleOutputLine) ──

  private handleCCEvent(raw: unknown): void {
    // The relay sends us already-parsed JSON objects, but parseCCOutputLine
    // expects a string. Re-serialize and parse through the same pipeline.
    const line = JSON.stringify(raw);
    const event = parseCCOutputLine(line);
    if (!event) return;

    if (event.type !== 'stream_event') {
      this.logger.info({ type: event.type, subtype: (event as unknown as Record<string, unknown>).subtype }, 'CC event');
    }

    this.resetHangTimer();

    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          this._sessionId = event.session_id;
          this._state = 'active';
          this.emit('stateChange', 'active');
          this.emit('init', event);
          this.flushQueue();
        } else if (event.subtype === 'api_error') {
          this.emit('api_error', event as ApiErrorEvent);
        } else if (event.subtype === 'task_started') {
          const taskId = (event as TaskStartedEvent).task_id;
          this._activeBackgroundTasks.add(taskId);
          this.clearIdleTimer();
          this.emit('task_started', event as TaskStartedEvent);
        } else if (event.subtype === 'task_progress') {
          this.emit('task_progress', event as TaskProgressEvent);
        } else if (event.subtype === 'compact_boundary') {
          this.emit('compact', event as CompactBoundaryEvent);
        } else if (event.subtype === 'task_completed') {
          const taskId = (event as TaskCompletedEvent).task_id;
          this._activeBackgroundTasks.delete(taskId);
          if (this._activeBackgroundTasks.size === 0) {
            this.startIdleTimer();
          }
          this.emit('task_completed', event as TaskCompletedEvent);
        }
        break;

      case 'assistant':
        if (event.message.stop_reason === 'tool_use') {
          this._ccActivity = 'tool_executing';
        }
        this.emit('assistant', event);
        break;

      case 'user': {
        const rawMeta = (event as { tool_use_result?: Record<string, unknown> }).tool_use_result;
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              let resultText: string;
              if (typeof block.content === 'string') {
                resultText = block.content;
              } else if (Array.isArray(block.content)) {
                const textParts: string[] = [];
                for (const c of block.content) {
                  if (c.type === 'text' && c.text) textParts.push(c.text);
                  else if (c.type === 'image' && c.source?.type === 'base64' && c.source.data) {
                    this.emit('media', { kind: 'image', media_type: c.source.media_type ?? 'image/png', data: c.source.data });
                  } else if (c.type === 'document' && c.source?.type === 'base64' && c.source.data) {
                    this.emit('media', { kind: 'document', media_type: c.source.media_type ?? 'application/pdf', data: c.source.data });
                  }
                }
                resultText = textParts.join('\n');
              } else {
                resultText = JSON.stringify(block.content);
              }

              this.emit('tool_result', {
                type: 'tool_result' as const,
                tool_use_id: block.tool_use_id,
                content: resultText,
                is_error: block.is_error === true,
                tool_use_result: rawMeta,
              });
            }
          }
        }
        break;
      }

      case 'tool_result':
        this._ccActivity = 'waiting_for_api';
        this.emit('tool_result', event);
        break;

      case 'result':
        this._ccActivity = 'idle';
        this._hadResult = true;
        this.clearHangTimer();
        if ((event as ResultEvent).total_cost_usd) {
          this._totalCostUsd = (event as ResultEvent).total_cost_usd!;
        }
        this.emit('result', event);
        this.startIdleTimer();
        break;

      case 'stream_event':
        this.updateActivityFromStreamEvent(event.event);
        this.emit('stream_event', event.event);
        break;

      case 'control_request':
        if ((event as PermissionRequest).request?.subtype === 'can_use_tool') {
          this.emit('permission_request', event as PermissionRequest);
        }
        break;

      case 'control_response':
        if (this._state === 'spawning') {
          this._state = 'active';
          this.emit('stateChange', 'active');
          this.flushQueue();
        }
        break;
    }

    this.emit('output', event);
  }

  private updateActivityFromStreamEvent(event: StreamInnerEvent): void {
    switch (event.type) {
      case 'message_start':
        this._ccActivity = 'responding';
        break;
      case 'content_block_start':
        if ('content_block' in event && event.content_block.type === 'tool_use') {
          this._ccActivity = 'responding';
        }
        break;
    }
  }

  // ── Send message to CC (via relay) ──

  sendMessage(msg: UserMessage): void {
    if (this._state === 'idle') {
      this.messageQueue.push(msg);
      this.start();
      return;
    }

    if (this._state === 'spawning') {
      this.messageQueue.push(msg);
      return;
    }

    this.writeToRelay(msg);
  }

  private writeToRelay(msg: UserMessage): void {
    this._hadResult = false;
    this._ccActivity = 'waiting_for_api';
    this.clearIdleTimer();
    this.startHangTimer();
    this.sendToRelay({ type: 'message', content: msg });
  }

  private flushQueue(): void {
    const queue = [...this.messageQueue];
    this.messageQueue = [];
    for (const msg of queue) {
      this.writeToRelay(msg);
    }
  }

  // ── Kill / Cancel ──

  kill(): void {
    this._killedByUs = true;
    this.sendToRelay({ type: 'kill' });
    this.clearAllTimers();
  }

  cancel(): void {
    this.sendToRelay({ type: 'cancel' });
  }

  // ── Tool result / Permission response ──

  sendToolResult(toolUseId: string, content: string): void {
    const msg = createToolResultMessage(toolUseId, content);
    this.sendToRelay({ type: 'message', content: msg });
  }

  respondToPermission(requestId: string, allowed: boolean, updatedInput?: Record<string, unknown>): void {
    const msg = createPermissionResponse(requestId, allowed, updatedInput);
    this.sendToRelay({ type: 'message', content: msg });
  }

  // ── Idle timer ──

  clearIdleTimer(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  startIdleTimer(): void {
    // No-op: idle timeout disabled — CC sessions stay alive until /new or explicit kill
  }

  // ── Hang timer ──

  private resetHangTimer(): void {
    this.clearHangTimer();
    this.startHangTimer();
  }

  private clearHangTimer(): void {
    if (this.hangTimer) { clearTimeout(this.hangTimer); this.hangTimer = null; }
  }

  private startHangTimer(): void {
    if (this._ccActivity === 'idle') return;
    this.clearHangTimer();
    const timeout = this.options.userConfig.hangTimeoutMs;
    this.hangTimer = setTimeout(() => {
      this.logger.warn({ activity: this._ccActivity }, 'Hang timeout in container CC');
      this.emit('hang', { activity: this._ccActivity });
    }, timeout);
  }

  // ── Exit handling ──

  private handleExit(code: number | null, signal: string | null): void {
    this._stateBeforeExit = this._state;
    this._activityBeforeExit = this._ccActivity;
    this._killedBeforeExit = this._killedByUs;
    this._state = 'idle';
    this._ccActivity = 'idle';
    this._pid = undefined;
    this.clearAllTimers();

    this.emit('exit', code, signal);
    this.emit('stateChange', 'idle');
  }

  // ── Socket I/O ──

  private sendToRelay(msg: RelayOutbound): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(JSON.stringify(msg) + '\n');
    } else {
      this.logger.warn({ type: msg.type }, 'sendToRelay: socket not available');
    }
  }

  // ── Cleanup ──

  private clearAllTimers(): void {
    this.clearIdleTimer();
    this.clearHangTimer();
    if (this.forceKillTimer) { clearTimeout(this.forceKillTimer); this.forceKillTimer = null; }
  }

  destroy(): void {
    this.clearAllTimers();
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
    this._state = 'idle';
    this.removeAllListeners();
  }
}
