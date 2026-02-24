import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type pino from 'pino';

// ── Types ──

export interface SessionInfo {
  id: string;
  title?: string;
  startedAt: string;
  lastActivity: string;
  messageCount: number;
  totalCostUsd: number;
}

export interface UserState {
  currentSessionId: string | null;
  lastActivity: string;
  model: string;
  repo: string;
  sessions: SessionInfo[];
  knownSessionIds: string[];  // session IDs created/used by TGCC
}

export interface AgentState {
  users: Record<string, UserState>;
}

export interface StateStore {
  agents: Record<string, AgentState>;
}

// ── Session Store ──

export class SessionStore {
  private state: StateStore;
  private filePath: string;
  private logger: pino.Logger;

  constructor(filePath: string, logger: pino.Logger) {
    this.filePath = filePath;
    this.logger = logger;
    this.state = this.load();
  }

  private load(): StateStore {
    try {
      if (existsSync(this.filePath)) {
        return JSON.parse(readFileSync(this.filePath, 'utf-8'));
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load state file — starting fresh');
    }
    return { agents: {} };
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      this.logger.error({ err }, 'Failed to save state file');
    }
  }

  private ensureUser(agentId: string, userId: string): UserState {
    if (!this.state.agents[agentId]) {
      this.state.agents[agentId] = { users: {} };
    }
    if (!this.state.agents[agentId].users[userId]) {
      this.state.agents[agentId].users[userId] = {
        currentSessionId: null,
        lastActivity: new Date().toISOString(),
        model: '',
        repo: '',
        sessions: [],
        knownSessionIds: [],
      };
    }
    return this.state.agents[agentId].users[userId];
  }

  getUser(agentId: string, userId: string): UserState {
    return this.ensureUser(agentId, userId);
  }

  setCurrentSession(agentId: string, userId: string, sessionId: string): void {
    const user = this.ensureUser(agentId, userId);
    user.currentSessionId = sessionId;
    user.lastActivity = new Date().toISOString();

    // Track as known TGCC session
    if (!user.knownSessionIds.includes(sessionId)) {
      user.knownSessionIds.push(sessionId);
    }

    // Add to session list if not already there
    if (!user.sessions.find(s => s.id === sessionId)) {
      user.sessions.push({
        id: sessionId,
        startedAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        messageCount: 0,
        totalCostUsd: 0,
      });
    }

    this.save();
  }

  updateSessionActivity(agentId: string, userId: string, cost?: number): void {
    const user = this.ensureUser(agentId, userId);
    user.lastActivity = new Date().toISOString();

    const session = user.sessions.find(s => s.id === user.currentSessionId);
    if (session) {
      session.lastActivity = new Date().toISOString();
      session.messageCount++;
      if (cost !== undefined) session.totalCostUsd = cost;
    }

    this.save();
  }

  setModel(agentId: string, userId: string, model: string): void {
    const user = this.ensureUser(agentId, userId);
    user.model = model;
    this.save();
  }

  setRepo(agentId: string, userId: string, repo: string): void {
    const user = this.ensureUser(agentId, userId);
    user.repo = repo;
    this.save();
  }

  setSessionTitle(agentId: string, userId: string, sessionId: string, title: string): void {
    const user = this.ensureUser(agentId, userId);
    const session = user.sessions.find(s => s.id === sessionId);
    if (session && !session.title) {
      session.title = title.slice(0, 40);
      this.save();
    }
  }

  clearSession(agentId: string, userId: string): void {
    const user = this.ensureUser(agentId, userId);
    user.currentSessionId = null;
    this.save();
  }

  deleteSession(agentId: string, userId: string, sessionId: string): boolean {
    const user = this.ensureUser(agentId, userId);
    const idx = user.sessions.findIndex(s => s.id === sessionId);
    if (idx === -1) return false;
    user.sessions.splice(idx, 1);
    user.knownSessionIds = user.knownSessionIds.filter(id => id !== sessionId);
    if (user.currentSessionId === sessionId) {
      user.currentSessionId = null;
    }
    this.save();
    return true;
  }

  getRecentSessions(agentId: string, userId: string, limit: number = 10): SessionInfo[] {
    const user = this.ensureUser(agentId, userId);
    return user.sessions.slice(-limit).reverse();
  }

  getFullState(): StateStore {
    return this.state;
  }
}

// ── /catchup — find CC sessions done outside TGCC ──

export interface MissedSession {
  id: string;
  mtime: Date;
  files: string[];
}

export function computeProjectSlug(repoPath: string): string {
  // CC stores at ~/.claude/projects/<slug>/sessions/
  // Slug is the path with / replaced by - and leading -
  return repoPath.replace(/\//g, '-');
}

export function findMissedSessions(
  repo: string,
  knownSessionIds: string[],
  lastActivity: Date,
): MissedSession[] {
  const slug = computeProjectSlug(repo);
  const sessionsDir = join(homedir(), '.claude', 'projects', slug, 'sessions');

  if (!existsSync(sessionsDir)) return [];

  const knownSet = new Set(knownSessionIds);
  const entries = readdirSync(sessionsDir);

  const missed: MissedSession[] = [];
  for (const entry of entries) {
    const entryPath = join(sessionsDir, entry);
    try {
      const stat = statSync(entryPath);
      if (!stat.isDirectory()) continue;
      if (stat.mtime <= lastActivity) continue;
      if (knownSet.has(entry)) continue;

      // List files in this session dir
      const files = readdirSync(entryPath);
      missed.push({ id: entry, mtime: stat.mtime, files });
    } catch {
      continue;
    }
  }

  return missed.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

export function parseSessionSummary(sessionDir: string): string {
  // Read session conversation data and produce a summary
  try {
    const files = readdirSync(sessionDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    if (jsonFiles.length === 0) return 'Empty session';

    // Read the conversation file
    for (const f of jsonFiles) {
      try {
        const content = JSON.parse(readFileSync(join(sessionDir, f), 'utf-8'));
        return extractSessionHighlights(content);
      } catch {
        continue;
      }
    }

    return `Session with ${files.length} file(s)`;
  } catch {
    return 'Could not read session';
  }
}

function extractSessionHighlights(data: unknown): string {
  if (!data || typeof data !== 'object') return 'Unknown session format';

  const highlights: string[] = [];
  const toolsUsed = new Set<string>();
  const filesEdited = new Set<string>();
  let turnCount = 0;

  // Try to parse as array of messages or as an object with messages
  const messages = Array.isArray(data)
    ? data
    : (data as Record<string, unknown>).messages as unknown[] ?? [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as Record<string, unknown>;

    if (m.role === 'assistant') {
      turnCount++;
      const content = m.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_use') {
            toolsUsed.add(b.name as string);
            // Extract file paths from tool inputs
            const input = b.input as Record<string, unknown> | undefined;
            if (input?.file_path) filesEdited.add(input.file_path as string);
            if (input?.path) filesEdited.add(input.path as string);
          }
          if (b.type === 'text' && typeof b.text === 'string' && highlights.length < 3) {
            const text = (b.text as string).slice(0, 100);
            if (text.trim()) highlights.push(text);
          }
        }
      }
    }
  }

  const parts: string[] = [];
  parts.push(`${turnCount} turn(s)`);
  if (toolsUsed.size > 0) parts.push(`Tools: ${[...toolsUsed].join(', ')}`);
  if (filesEdited.size > 0) parts.push(`Files: ${[...filesEdited].slice(0, 5).join(', ')}`);
  if (highlights.length > 0) parts.push(`Topic: ${highlights[0]}`);

  return parts.join(' | ');
}

export function formatCatchupMessage(repo: string, missed: MissedSession[]): string {
  if (missed.length === 0) {
    return "You're up to date — no external CC activity since your last message.";
  }

  const slug = computeProjectSlug(repo);
  const sessionsDir = join(homedir(), '.claude', 'projects', slug, 'sessions');

  const lines = [`*External CC activity* (${missed.length} session(s)):\n`];

  for (const session of missed.slice(0, 5)) {
    const age = formatAge(session.mtime);
    const summary = parseSessionSummary(join(sessionsDir, session.id));
    lines.push(`\`${session.id.slice(0, 8)}\` (${age})`);
    lines.push(`  ${summary}\n`);
  }

  if (missed.length > 5) {
    lines.push(`...and ${missed.length - 5} more session(s).`);
  }

  lines.push(`\nUse /resume <id> to continue any of these sessions.`);
  return lines.join('\n');
}

function formatAge(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
