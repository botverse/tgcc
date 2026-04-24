/**
 * CLI-side PTY manager for interactive CC sessions.
 *
 * Spawns CC in a pseudo-terminal via node-pty so the user sees the full TUI.
 * Watches the JSONL session file to detect thinking/idle state transitions.
 * Exposes write() for message injection from Telegram.
 *
 * This class runs in the `tgcc attach` CLI binary, NOT in the daemon.
 * The daemon gets events forwarded over the ctl socket.
 */

import { EventEmitter } from 'node:events';
import { watch, existsSync, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import { computeProjectSlug } from './session.js';

// ── Types ──

export type CliState = 'idle' | 'thinking';

export interface CliProcessOptions {
  /** Path to CC binary (e.g. 'claude' or '/home/user/.local/bin/claude'). */
  ccBinaryPath: string;
  /** Working directory / repo path. */
  repo: string;
  /** Extra args to pass to CC (e.g. --mcp-config, --resume, --session-id). */
  args?: string[];
  /** PTY column width. Default: 220 */
  cols?: number;
  /** PTY row height. Default: 50 */
  rows?: number;
  /** Override CLAUDE_CONFIG_DIR for session isolation. */
  claudeConfigDir?: string;
}

export interface CliProcessEvents {
  /** PTY output data (for forwarding to the real terminal). */
  data: (data: string) => void;
  /** CC state changed (detected from JSONL watcher). */
  state: (state: CliState) => void;
  /** Session ID detected from JSONL filename. */
  session: (sessionId: string) => void;
  /** CC process exited. */
  exit: (exitCode: number, signal?: number) => void;
  /** Error from PTY or watcher. */
  error: (err: Error) => void;
}

// ── CliProcess ──

export class CliProcess extends EventEmitter {
  private pty: IPty | null = null;
  private _state: CliState = 'idle';
  private _sessionId: string | null = null;
  private _pid: number | undefined;
  private _exitCode: number | null = null;
  private options: CliProcessOptions;

  // JSONL watcher state
  private jsonlWatcher: ReturnType<typeof watch> | null = null;
  private jsonlPath: string | null = null;
  private jsonlOffset = 0;
  private projectDir: string;
  private dirWatcher: ReturnType<typeof watch> | null = null;
  private sessionDetected = false;

  constructor(options: CliProcessOptions) {
    super();
    this.options = options;

    // Pre-compute the project directory where CC writes JSONL files
    const configBase = options.claudeConfigDir ?? join(homedir(), '.claude');
    const slug = computeProjectSlug(options.repo);
    this.projectDir = join(configBase, 'projects', slug);
  }

  get state(): CliState { return this._state; }
  get sessionId(): string | null { return this._sessionId; }
  get pid(): number | undefined { return this._pid; }
  get exitCode(): number | null { return this._exitCode; }

  // ── Spawn ──

  /** Spawn CC in a PTY. Call this once. */
  start(): void {
    if (this.pty) throw new Error('CliProcess already started');

    const cols = this.options.cols ?? 220;
    const rows = this.options.rows ?? 50;

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    if (this.options.claudeConfigDir) {
      env.CLAUDE_CONFIG_DIR = this.options.claudeConfigDir;
    }

    const args = this.options.args ?? [];

    this.pty = ptySpawn(this.options.ccBinaryPath, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.options.repo,
      env,
    });

    this._pid = this.pty.pid;

    // Forward PTY output
    this.pty.onData((data) => {
      this.emit('data', data);
    });

    // Handle exit
    this.pty.onExit(({ exitCode, signal }) => {
      this._exitCode = exitCode;
      this.cleanup();
      this.emit('exit', exitCode, signal);
    });

    // Start watching for session JSONL file
    this.startSessionDetection();
  }

  // ── PTY I/O ──

  /** Write data to the PTY (e.g. user keystrokes or injected text). */
  write(data: string): void {
    if (!this.pty) throw new Error('CliProcess not started');
    this.pty.write(data);
  }

  /** Inject a message as if the user typed it and pressed Enter. */
  inject(text: string): void {
    // Write the text followed by carriage return (Enter key)
    this.write(text + '\r');
  }

  /** Resize the PTY. */
  resize(cols: number, rows: number): void {
    if (this.pty) this.pty.resize(cols, rows);
  }

  /** Send SIGTERM to CC. */
  kill(): void {
    if (this.pty) {
      try { this.pty.kill('SIGTERM'); } catch {}
    }
  }

  /** Send SIGINT to CC (cancel current operation). */
  cancel(): void {
    if (this.pty) {
      try { this.pty.kill('SIGINT'); } catch {}
    }
  }

  /** Clean up all resources. */
  destroy(): void {
    this.kill();
    this.cleanup();
  }

  // ── Session Detection ──

  /**
   * Watch the project directory for new .jsonl files.
   * CC creates the session file shortly after startup.
   */
  private startSessionDetection(): void {
    // If the directory doesn't exist yet, wait for it
    if (!existsSync(this.projectDir)) {
      // Poll briefly for directory creation (CC creates it on first run)
      const interval = setInterval(() => {
        if (existsSync(this.projectDir)) {
          clearInterval(interval);
          this.watchProjectDir();
        }
      }, 500);
      // Stop polling after 30s
      setTimeout(() => clearInterval(interval), 30_000);
      return;
    }

    this.watchProjectDir();
  }

  private watchProjectDir(): void {
    // Snapshot existing files to detect new ones
    const existingFiles = new Set<string>();
    try {
      for (const f of readdirSync(this.projectDir)) {
        if (f.endsWith('.jsonl')) existingFiles.add(f);
      }
    } catch {}

    // Watch for new files
    try {
      this.dirWatcher = watch(this.projectDir, (eventType, filename) => {
        if (this.sessionDetected) return;
        if (!filename?.endsWith('.jsonl')) return;

        // New JSONL file that didn't exist before = our session
        if (!existingFiles.has(filename)) {
          const sessionId = filename.replace('.jsonl', '');
          this.onSessionDetected(sessionId);
        }
      });
    } catch {
      // Directory watch failed — fall back to polling
    }

    // Also check for very recently modified files (in case CC reuses a session)
    // This handles --resume and --continue cases
    this.checkRecentJsonl(existingFiles);
  }

  /**
   * Check if a JSONL file was modified very recently (within 2s of our spawn).
   * Handles --resume/--continue where CC writes to an existing file.
   */
  private checkRecentJsonl(existingFiles: Set<string>): void {
    const now = Date.now();
    const checkInterval = setInterval(() => {
      if (this.sessionDetected) {
        clearInterval(checkInterval);
        return;
      }

      try {
        for (const f of readdirSync(this.projectDir)) {
          if (!f.endsWith('.jsonl')) continue;

          // For existing files: check if modified after our spawn
          if (existingFiles.has(f)) {
            const stat = statSync(join(this.projectDir, f));
            if (stat.mtimeMs > now - 1000) {
              const sessionId = f.replace('.jsonl', '');
              this.onSessionDetected(sessionId);
              clearInterval(checkInterval);
              return;
            }
          }
        }
      } catch {}
    }, 1000);

    // Stop checking after 30s
    setTimeout(() => clearInterval(checkInterval), 30_000);
  }

  private onSessionDetected(sessionId: string): void {
    if (this.sessionDetected) return;
    this.sessionDetected = true;
    this._sessionId = sessionId;

    // Stop directory watcher
    if (this.dirWatcher) {
      this.dirWatcher.close();
      this.dirWatcher = null;
    }

    // Start watching the JSONL file for state changes
    this.jsonlPath = join(this.projectDir, `${sessionId}.jsonl`);
    this.startJsonlWatcher();

    this.emit('session', sessionId);
  }

  // ── JSONL State Watcher ──

  /**
   * Watch the session JSONL file for new lines to detect state transitions.
   *
   * CC writes lines like:
   * - `{"type":"human","message":{"role":"user",...}}` → user sent input
   * - `{"type":"assistant","message":{"role":"assistant",...}}` → CC is responding (thinking)
   * - `{"type":"result",...}` → CC finished its turn (idle)
   */
  private startJsonlWatcher(): void {
    if (!this.jsonlPath) return;

    // Seek to end of file (we only care about new events)
    try {
      const stat = statSync(this.jsonlPath);
      this.jsonlOffset = stat.size;
    } catch {
      this.jsonlOffset = 0;
    }

    try {
      this.jsonlWatcher = watch(this.jsonlPath, () => {
        this.readNewJsonlLines();
      });
    } catch (err) {
      this.emit('error', new Error(`Failed to watch JSONL: ${(err as Error).message}`));
    }
  }

  /**
   * Read new bytes from the JSONL file and parse complete lines.
   * Uses low-level read to avoid keeping the file open.
   */
  private readNewJsonlLines(): void {
    if (!this.jsonlPath) return;

    let fd: number | null = null;
    try {
      const stat = statSync(this.jsonlPath);
      if (stat.size <= this.jsonlOffset) return;

      const bytesToRead = stat.size - this.jsonlOffset;
      const buf = Buffer.alloc(bytesToRead);

      fd = openSync(this.jsonlPath, 'r');
      readSync(fd, buf, 0, bytesToRead, this.jsonlOffset);
      closeSync(fd);
      fd = null;

      this.jsonlOffset = stat.size;

      // Parse complete lines
      const text = buf.toString('utf-8');
      const lines = text.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;
        this.processJsonlLine(line);
      }
    } catch {
      // File may be briefly unavailable during write
      if (fd !== null) {
        try { closeSync(fd); } catch {}
      }
    }
  }

  private processJsonlLine(line: string): void {
    try {
      const event = JSON.parse(line) as { type: string; [key: string]: unknown };

      switch (event.type) {
        case 'assistant': {
          // CC started responding → thinking
          if (this._state !== 'thinking') {
            this._state = 'thinking';
            this.emit('state', 'thinking');
          }
          break;
        }
        case 'result': {
          // CC finished its turn → idle
          if (this._state !== 'idle') {
            this._state = 'idle';
            this.emit('state', 'idle');
          }
          break;
        }
        // 'human' type = user message — no state change needed
      }
    } catch {
      // Non-JSON or malformed line — ignore
    }
  }

  // ── Cleanup ──

  private cleanup(): void {
    if (this.jsonlWatcher) {
      this.jsonlWatcher.close();
      this.jsonlWatcher = null;
    }
    if (this.dirWatcher) {
      this.dirWatcher.close();
      this.dirWatcher = null;
    }
    this.pty = null;
  }
}
