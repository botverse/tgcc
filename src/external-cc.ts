// ── External CC Manager ──
//
// Tracks Claude Code sessions launched in tmux windows OUTSIDE tgcc.
// These run `claude --remote-control` so they appear in the Claude
// desktop/phone apps; tgcc only creates, lists, and kills them.
//
// Tracked sessions persist to ~/.tgcc/external-cc.json across restarts.
// Cleanup drops entries whose tmux window no longer exists.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { execSync } from 'node:child_process';
import type pino from 'pino';

// ── Types ──

export interface ExternalCcSession {
  /** Display name passed to `claude -n` (and `-w` for worktree sessions). */
  name: string;
  /** Repo key from the config repos registry. */
  repoName: string;
  /** Absolute repo path (cwd of the tmux window). */
  repoPath: string;
  /** tmux session the window was created in. */
  tmuxSession: string;
  /** Stable tmux window id (e.g. "@42") — survives renames, unique per tmux server. */
  windowId: string;
  /** True when created with `-w` (git worktree). */
  worktree: boolean;
  createdAt: number;
}

/** Fallback tmux session when no session named after the repo exists. */
const FALLBACK_TMUX_SESSION = 'tgcc';

/** Expanded form of the user's `cc` alias — aliases don't resolve in tmux's sh -c. */
const CC_BASE_ARGS = ['claude', '--dangerously-skip-permissions', '--remote-control'];

// ── Helpers ──

/** Single-quote a string for sh. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Sanitize a user-supplied session name to something tmux/shell/git-branch safe. */
export function sanitizeSessionName(raw: string): string {
  return raw.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
}

/** Human-readable relative time, e.g. "3h ago". */
export function formatAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── ExternalCcManager ──

export class ExternalCcManager {
  private sessions: ExternalCcSession[] = [];

  constructor(
    private filePath: string,
    private logger: pino.Logger,
  ) {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      if (Array.isArray(raw?.sessions)) this.sessions = raw.sessions;
    } catch (err) {
      this.logger.warn({ err }, 'ExternalCc: failed to load tracked sessions');
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify({ sessions: this.sessions }, null, 2));
    } catch (err) {
      this.logger.warn({ err }, 'ExternalCc: failed to persist tracked sessions');
    }
  }

  list(): ExternalCcSession[] {
    return [...this.sessions];
  }

  find(windowId: string): ExternalCcSession | undefined {
    return this.sessions.find((s) => s.windowId === windowId);
  }

  /** Window ids across all tmux sessions. Empty when the tmux server is down (= all windows dead). */
  private liveWindowIds(): Set<string> {
    try {
      const out = execSync("tmux list-windows -a -F '#{window_id}' 2>/dev/null", { encoding: 'utf-8' });
      return new Set(out.trim().split('\n').filter(Boolean));
    } catch {
      return new Set();
    }
  }

  private tmuxSessionNames(): Set<string> {
    try {
      const out = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", { encoding: 'utf-8' });
      return new Set(out.trim().split('\n').filter(Boolean));
    } catch {
      return new Set();
    }
  }

  /** Drop tracked sessions whose tmux window no longer exists. Returns the removed entries. */
  cleanup(): ExternalCcSession[] {
    if (this.sessions.length === 0) return [];
    const live = this.liveWindowIds();
    const removed = this.sessions.filter((s) => !live.has(s.windowId));
    if (removed.length > 0) {
      this.sessions = this.sessions.filter((s) => live.has(s.windowId));
      this.save();
      this.logger.info({ removed: removed.map((s) => s.name) }, 'ExternalCc: cleaned up dead sessions');
    }
    return removed;
  }

  /**
   * Launch a CC session in a new tmux window and track it.
   * Target session: one named after the repo if it exists, else the tgcc
   * session (created detached if missing). Throws on tmux failure.
   */
  create(opts: { name: string; repoName: string; repoPath: string; worktree: boolean }): ExternalCcSession {
    const existing = this.tmuxSessionNames();
    let tmuxSession = opts.repoName;
    if (!existing.has(tmuxSession)) {
      tmuxSession = FALLBACK_TMUX_SESSION;
      if (!existing.has(tmuxSession)) {
        execSync(`tmux new-session -d -s ${shq(tmuxSession)} -c ${shq(opts.repoPath)}`, { stdio: 'ignore' });
      }
    }

    const ccArgs = [...CC_BASE_ARGS, '-n', shq(opts.name)];
    if (opts.worktree) ccArgs.push('-w', shq(opts.name));
    const ccCmd = ccArgs.join(' ');

    // -d: don't steal focus from an attached client; -P -F: print the stable window id
    const out = execSync(
      `tmux new-window -d -P -F '#{window_id}' -t ${shq(tmuxSession)} -n ${shq(opts.name)} -c ${shq(opts.repoPath)} ${shq(ccCmd)}`,
      { encoding: 'utf-8' },
    );
    const windowId = out.trim();
    if (!windowId.startsWith('@')) {
      throw new Error(`tmux did not return a window id (got: ${windowId || 'nothing'})`);
    }

    const session: ExternalCcSession = {
      name: opts.name,
      repoName: opts.repoName,
      repoPath: opts.repoPath,
      tmuxSession,
      windowId,
      worktree: opts.worktree,
      createdAt: Date.now(),
    };
    this.sessions.push(session);
    this.save();
    this.logger.info({ name: opts.name, tmuxSession, windowId, worktree: opts.worktree }, 'ExternalCc: session created');
    return session;
  }

  /** Kill the tmux window (and the CC process in it), then untrack. */
  kill(windowId: string): ExternalCcSession | null {
    const session = this.find(windowId);
    try {
      execSync(`tmux kill-window -t ${shq(windowId)}`, { stdio: 'ignore' });
    } catch {
      // Window already gone — still untrack below.
    }
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.windowId !== windowId);
    if (this.sessions.length !== before) this.save();
    return session ?? null;
  }
}
