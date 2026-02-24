import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import type pino from 'pino';
import {
  type CCOutputEvent,
  type UserMessage,
  type StreamInnerEvent,
  type ApiErrorEvent,
  parseCCOutputLine,
  serializeMessage,
  createInitializeRequest,
} from './cc-protocol.js';
import type { ResolvedUserConfig } from './config.js';

// ── Types ──

export type ProcessState = 'idle' | 'spawning' | 'active';

/** CC activity state derived from stream events for smart hang detection. */
export type CCActivityState = 'idle' | 'responding' | 'tool_executing' | 'waiting_for_api';

// ── Process tree check ──

/** Check if a process has active child processes (tool execution signal). */
export function hasActiveChildren(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    execSync(`pgrep --parent ${pid}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface CCProcessOptions {
  agentId: string;
  userId: string;
  ccBinaryPath: string;
  userConfig: ResolvedUserConfig;
  mcpConfigPath?: string;
  sessionId?: string;
  continueSession: boolean;
  logger: pino.Logger;
}

// ── MCP config generation ──

export function generateMcpConfig(
  agentId: string,
  userId: string,
  socketDir: string,
  mcpServerPath: string,
): string {
  const config = {
    mcpServers: {
      tgcc: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          TGCC_AGENT_ID: agentId,
          TGCC_USER_ID: userId,
          TGCC_SOCKET: join(socketDir, `${agentId}-${userId}.sock`),
        },
      },
    },
  };

  const dir = '/tmp/tgcc';
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const configPath = join(dir, `mcp-${agentId}-${userId}.json`);
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

// ── CC Process ──

export class CCProcess extends EventEmitter {
  readonly agentId: string;
  readonly userId: string;

  private process: ChildProcess | null = null;
  private _state: ProcessState = 'idle';
  private _ccActivity: CCActivityState = 'idle';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private hangTimer: ReturnType<typeof setTimeout> | null = null;
  private messageQueue: UserMessage[] = [];
  private logger: pino.Logger;
  private options: CCProcessOptions;
  private _sessionId: string | null = null;
  private _totalCostUsd = 0;
  private _spawnedAt: Date | null = null;
  private _killedByUs = false;
  private _takenOver = false;

  constructor(options: CCProcessOptions) {
    super();
    this.agentId = options.agentId;
    this.userId = options.userId;
    this.options = options;
    this.logger = options.logger.child({ agentId: options.agentId, userId: options.userId });
  }

  get state(): ProcessState { return this._state; }
  get ccActivity(): CCActivityState { return this._ccActivity; }
  get sessionId(): string | null { return this._sessionId; }
  get totalCostUsd(): number { return this._totalCostUsd; }
  get spawnedAt(): Date | null { return this._spawnedAt; }
  get pid(): number | undefined { return this.process?.pid; }
  get takenOver(): boolean { return this._takenOver; }

  // ── Spawn ──

  async start(): Promise<void> {
    if (this._state !== 'idle') {
      this.logger.warn({ state: this._state }, 'Cannot start — not idle');
      return;
    }

    this._state = 'spawning';
    this.emit('stateChange', 'spawning');

    const args = this.buildArgs();
    this.logger.info({ args }, 'Spawning CC process');

    const child = spawn(this.options.ccBinaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.userConfig.repo,
      env: { ...process.env },
    });

    this.process = child;
    this._spawnedAt = new Date();

    // Parse stdout as NDJSON
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => this.handleOutputLine(line));

    // Log stderr
    const stderrRl = createInterface({ input: child.stderr! });
    stderrRl.on('line', (line) => {
      this.logger.debug({ stderr: line }, 'CC stderr');
    });

    child.on('error', (err) => {
      this.logger.error({ err }, 'CC process error');
      this.cleanup();
      this.emit('error', err);
    });

    child.on('exit', (code, signal) => {
      this.logger.info({ code, signal, killedByUs: this._killedByUs }, 'CC process exited');

      // Detect session takeover: unexpected exit not initiated by us
      if (!this._killedByUs && (code !== 0 || signal)) {
        this._takenOver = true;
        this.logger.warn({ code, signal }, 'CC exited unexpectedly — possible session takeover');
        this.emit('takeover', code, signal);
      }

      this.cleanup();
      this.emit('exit', code, signal);
    });

    // Send SDK initialize handshake (required by CC v2.1.50+ stream-json mode)
    this.sendInitializeRequest();
  }

  private sendInitializeRequest(): void {
    if (!this.process?.stdin?.writable) {
      this.logger.error('Cannot send initialize request — stdin not writable');
      return;
    }
    const req = createInitializeRequest();
    const line = JSON.stringify(req) + '\n';
    this.process.stdin.write(line);
    this.logger.info({ request_id: req.request_id }, 'Sent initialize control_request');
  }

  private buildArgs(): string[] {
    const cfg = this.options.userConfig;
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--max-turns', String(cfg.maxTurns),
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
      // 'default' → no flag (CC's built-in flow)
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

  // ── Handle CC output ──

  private handleOutputLine(line: string): void {
    const event = parseCCOutputLine(line);
    if (!event) return;

    // Reset hang timer on any output
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
        }
        break;

      case 'assistant':
        // If assistant message has stop_reason 'tool_use', CC will execute the tool
        if (event.message.stop_reason === 'tool_use') {
          this._ccActivity = 'tool_executing';
        }
        this.emit('assistant', event);
        break;

      case 'tool_result':
        // Tool result sent back to CC → CC will call API with result
        this._ccActivity = 'waiting_for_api';
        this.emit('tool_result', event);
        break;

      case 'result':
        // Turn complete
        this._ccActivity = 'idle';
        if (event.total_cost_usd) {
          this._totalCostUsd = event.total_cost_usd;
        }
        this.emit('result', event);
        this.startIdleTimer();
        break;

      case 'stream_event':
        this.updateActivityFromStreamEvent(event.event);
        this.emit('stream_event', event.event);
        break;

      case 'control_response':
        this.logger.info('Received control_response — CC initialized');
        if (this._state === 'spawning') {
          this._state = 'active';
          this.emit('stateChange', 'active');
          this.flushQueue();
        }
        break;
    }

    this.emit('output', event);
  }

  /** Update CC activity state from stream events. */
  private updateActivityFromStreamEvent(event: StreamInnerEvent): void {
    switch (event.type) {
      case 'message_start':
        // CC started producing content — API responded
        this._ccActivity = 'responding';
        break;
      case 'content_block_start':
        if ('content_block' in event && event.content_block.type === 'tool_use') {
          // Tool use block started — will transition to tool_executing on assistant message
          this._ccActivity = 'responding';
        }
        break;
      // message_stop and content_block_stop don't change activity —
      // the assistant message with stop_reason handles the transition
    }
  }

  // ── Send message to CC ──

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

    // Active — write directly
    this.writeToStdin(msg);
    this._ccActivity = 'waiting_for_api';
    this.clearIdleTimer();
    this.startHangTimer();
  }

  private writeToStdin(msg: UserMessage): void {
    if (!this.process?.stdin?.writable) {
      this.logger.error('Cannot write to CC stdin — process not available');
      return;
    }
    const line = serializeMessage(msg) + '\n';
    this.process.stdin.write(line);
    this.logger.debug({ uuid: msg.uuid }, 'Wrote message to CC stdin');
  }

  private flushQueue(): void {
    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift()!;
      this.writeToStdin(msg);
    }
  }

  // ── Timers ──

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.logger.info('Idle timeout — killing CC process');
      this.kill();
    }, this.options.userConfig.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private startHangTimer(): void {
    this.clearHangTimer();
    this.hangTimer = setTimeout(() => {
      this.handleHangTimeout();
    }, this.options.userConfig.hangTimeoutMs);
  }

  /** State-aware hang detection: check CC activity before killing. */
  private handleHangTimeout(): void {
    const activity = this._ccActivity;
    const pid = this.pid;

    if (activity === 'tool_executing') {
      // CC is executing a tool — check for active child processes
      if (hasActiveChildren(pid)) {
        this.logger.info('Hang timer: tool_executing with active children — extending 5 min');
        this.startHangTimer(); // restart the timer
        return;
      }
      // No children but supposedly executing a tool — wait 60s more
      this.logger.info('Hang timer: tool_executing but no children — waiting 60s');
      this.hangTimer = setTimeout(() => {
        if (hasActiveChildren(pid)) {
          this.logger.info('Hang timer: children appeared — extending');
          this.startHangTimer();
        } else {
          this.logger.warn('Hang timer: tool_executing, still no children — truly hung');
          this.emit('hang');
          this.kill();
        }
      }, 60_000);
      return;
    }

    if (activity === 'waiting_for_api') {
      // API calls can be slow — extend
      this.logger.info('Hang timer: waiting_for_api — extending');
      this.startHangTimer();
      return;
    }

    // responding or idle with no output for hangTimeoutMs — truly hung
    this.logger.warn({ activity }, 'Hang timeout — truly hung, killing');
    this.emit('hang');
    this.kill();
  }

  private clearHangTimer(): void {
    if (this.hangTimer) {
      clearTimeout(this.hangTimer);
      this.hangTimer = null;
    }
  }

  private resetHangTimer(): void {
    if (this.hangTimer) {
      this.startHangTimer();
    }
  }

  // ── Lifecycle ──

  kill(): void {
    if (!this.process) return;

    this._killedByUs = true;
    this.logger.info('Sending SIGTERM to CC process');
    this.process.kill('SIGTERM');

    // Force kill after 5s
    const forceTimer = setTimeout(() => {
      if (this.process && !this.process.killed) {
        this.logger.warn('Force killing CC process with SIGKILL');
        this.process.kill('SIGKILL');
      }
    }, 5000);

    this.process.once('exit', () => clearTimeout(forceTimer));
  }

  /** Send SIGINT to cancel current turn without killing process */
  cancel(): void {
    if (this.process && this._state === 'active') {
      this.logger.info('Sending SIGINT to cancel current turn');
      this.process.kill('SIGINT');
    }
  }

  private cleanup(): void {
    this.clearIdleTimer();
    this.clearHangTimer();
    this._state = 'idle';
    this._ccActivity = 'idle';
    this._killedByUs = false;
    this.process = null;
    this.emit('stateChange', 'idle');
  }

  destroy(): void {
    this.kill();
    this.removeAllListeners();
  }
}
