import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
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

export interface JsonlTracking {
  size: number;
  mtimeMs: number;
}

export interface UserState {
  currentSessionId: string | null;
  lastActivity: string;
  model: string;
  repo: string;
  permissionMode: string;      // session override for permission mode (empty = use agent default)
  sessions: SessionInfo[];
  knownSessionIds: string[];  // session IDs created/used by TGCC
  jsonlTracking?: JsonlTracking; // track session JSONL file size/mtime for staleness detection
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
        permissionMode: '',
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

  setPermissionMode(agentId: string, userId: string, mode: string): void {
    const user = this.ensureUser(agentId, userId);
    user.permissionMode = mode;
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

  updateJsonlTracking(agentId: string, userId: string, size: number, mtimeMs: number): void {
    const user = this.ensureUser(agentId, userId);
    user.jsonlTracking = { size, mtimeMs };
    this.save();
  }

  getJsonlTracking(agentId: string, userId: string): JsonlTracking | undefined {
    const user = this.ensureUser(agentId, userId);
    return user.jsonlTracking;
  }

  clearJsonlTracking(agentId: string, userId: string): void {
    const user = this.ensureUser(agentId, userId);
    delete user.jsonlTracking;
    this.save();
  }

  clearSession(agentId: string, userId: string): void {
    const user = this.ensureUser(agentId, userId);
    user.currentSessionId = null;
    delete user.jsonlTracking;
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

// ── Session JSONL path resolution ──

/**
 * Get the path to a CC session's JSONL file.
 * CC stores sessions at ~/.claude/projects/<repo-slug>/<sessionId>.jsonl
 */
export function getSessionJsonlPath(sessionId: string, repo: string): string {
  const slug = computeProjectSlug(repo);
  return join(homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

// ── Staleness summary ──

interface JsonlTurn {
  role: 'user' | 'assistant';
  text?: string;
  tools?: string[];
}

/**
 * Read new JSONL entries from a byte offset and summarize the turns.
 * Returns a formatted catch-up message or null if nothing meaningful was found.
 */
export function summarizeJsonlDelta(jsonlPath: string, fromByteOffset: number, maxChars = 2000): string | null {
  let rawBytes: Buffer;
  try {
    const stat = statSync(jsonlPath);
    if (stat.size <= fromByteOffset) return null;

    const bytesToRead = stat.size - fromByteOffset;
    rawBytes = Buffer.alloc(bytesToRead);
    const fd = openSync(jsonlPath, 'r');
    try {
      readSync(fd, rawBytes, 0, bytesToRead, fromByteOffset);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = rawBytes.toString('utf-8').split('\n').filter(Boolean);
  const turns: JsonlTurn[] = [];

  // Track seen assistant message UUIDs to deduplicate partial updates
  const seenAssistantUuids = new Map<string, number>(); // uuid → index in turns

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const entryType = entry.type as string;
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    if (entryType === 'user' && msg.role === 'user') {
      const content = msg.content;
      let text: string | undefined;
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        const textBlock = content.find((b: Record<string, unknown>) => b.type === 'text');
        if (textBlock) text = (textBlock as Record<string, unknown>).text as string;
      }
      if (text) {
        turns.push({ role: 'user', text: text.slice(0, 200) });
      }
    } else if (entryType === 'assistant' && msg.role === 'assistant') {
      const uuid = entry.uuid as string | undefined;
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (!content || !Array.isArray(content)) continue;

      // Extract text and tools from this assistant message
      const texts: string[] = [];
      const tools: string[] = [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const trimmed = (block.text as string).trim();
          if (trimmed) texts.push(trimmed);
        } else if (block.type === 'tool_use') {
          tools.push(block.name as string);
        }
      }

      // Deduplicate: CC emits partial assistant messages with the same UUID
      // as it streams. Keep updating the same turn entry.
      if (uuid && seenAssistantUuids.has(uuid)) {
        const idx = seenAssistantUuids.get(uuid)!;
        const existing = turns[idx];
        if (texts.length > 0) existing.text = texts.join(' ').slice(0, 200);
        if (tools.length > 0) existing.tools = [...new Set([...(existing.tools ?? []), ...tools])];
      } else {
        const turn: JsonlTurn = { role: 'assistant' };
        if (texts.length > 0) turn.text = texts.join(' ').slice(0, 200);
        if (tools.length > 0) turn.tools = tools;
        if (uuid) seenAssistantUuids.set(uuid, turns.length);
        turns.push(turn);
      }
    }
  }

  // Filter out empty assistant turns (only had thinking blocks, etc.)
  const meaningful = turns.filter(t => t.text || (t.tools && t.tools.length > 0));
  if (meaningful.length === 0) return null;

  return formatStaleSummary(meaningful, maxChars);
}

function escapeHtmlBasic(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatStaleSummary(turns: JsonlTurn[], maxChars: number): string {
  const turnCount = turns.filter(t => t.role === 'assistant').length;
  const header = `ℹ️ <b>Session was updated from another client</b> (${turnCount} CC turn${turnCount !== 1 ? 's' : ''} since your last message here):\n\n`;

  const lines: string[] = [];
  // Build from newest to oldest so we can truncate old ones
  for (const turn of turns) {
    if (turn.role === 'user') {
      const preview = escapeHtmlBasic(truncateText(turn.text ?? '', 80));
      lines.push(`• <b>You:</b> "${preview}"`);
    } else {
      const parts: string[] = [];
      if (turn.tools && turn.tools.length > 0) {
        parts.push(`Used ${turn.tools.map(t => escapeHtmlBasic(t)).join(', ')}`);
      }
      if (turn.text) {
        const preview = escapeHtmlBasic(truncateText(turn.text, 120));
        parts.push(`"${preview}"`);
      }
      lines.push(`• <b>CC:</b> ${parts.join(' — ') || '(no text)'}`);
    }
  }

  // Truncate from the front (oldest) if too long
  let body = lines.join('\n');
  while (body.length + header.length + 20 > maxChars && lines.length > 2) {
    lines.shift();
    body = `…\n${lines.join('\n')}`;
  }

  return header + body + '\n\n_Reconnecting..._';
}

function truncateText(text: string, maxLen: number): string {
  // Collapse whitespace
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 1) + '…';
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

  const lines = [`<b>External CC activity</b> (${missed.length} session(s)):\n`];

  for (const session of missed.slice(0, 5)) {
    const age = formatAge(session.mtime);
    const summary = parseSessionSummary(join(sessionsDir, session.id));
    lines.push(`<code>${session.id.slice(0, 8)}</code> (${age})`);
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
