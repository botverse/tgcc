import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type pino from 'pino';

// ── Types ──

/** @deprecated Kept for migration from old per-user format */
export interface UserState {
  currentSessionId: string | null;
  lastActivity: string;
  model: string;
  repo: string;
  permissionMode: string;
}

export interface AgentState {
  repo: string;
  model: string;
  permissionMode: string;
  lastActivity: string;
}

/** Old format for migration detection */
interface OldAgentState {
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
        const raw = JSON.parse(readFileSync(this.filePath, 'utf-8'));
        // Migrate: if old per-user format detected, convert to per-agent
        const migrated: StateStore = { agents: {} };
        for (const agentId of Object.keys(raw.agents ?? {})) {
          const agentData = raw.agents[agentId];
          if (agentData && 'users' in agentData && typeof agentData.users === 'object') {
            // Old format — pick first user's values
            const oldState = agentData as OldAgentState;
            const firstUserId = Object.keys(oldState.users)[0];
            if (firstUserId) {
              const u = oldState.users[firstUserId];
              migrated.agents[agentId] = {
                repo: u.repo || '',
                model: u.model || '',
                permissionMode: u.permissionMode || '',
                lastActivity: u.lastActivity || new Date().toISOString(),
              };
            } else {
              migrated.agents[agentId] = {
                repo: '',
                model: '',
                permissionMode: '',
                lastActivity: new Date().toISOString(),
              };
            }
            this.logger.info({ agentId }, 'Migrated agent state from per-user to per-agent format');
          } else if (agentData && typeof agentData.repo === 'string') {
            // Already new format
            migrated.agents[agentId] = agentData as AgentState;
          } else {
            // Unknown format, skip
            migrated.agents[agentId] = {
              repo: '',
              model: '',
              permissionMode: '',
              lastActivity: new Date().toISOString(),
            };
          }
        }
        return migrated;
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

  private ensureAgent(agentId: string): AgentState {
    if (!this.state.agents[agentId]) {
      this.state.agents[agentId] = {
        repo: '',
        model: '',
        permissionMode: '',
        lastActivity: new Date().toISOString(),
      };
    }
    return this.state.agents[agentId];
  }

  getAgent(agentId: string): AgentState {
    return this.ensureAgent(agentId);
  }

  /** @deprecated Alias for getAgent — eases migration. Returns AgentState (not UserState). */
  getUser(agentId: string, _userId?: string): AgentState {
    return this.ensureAgent(agentId);
  }

  setModel(agentId: string, model: string): void {
    const agent = this.ensureAgent(agentId);
    agent.model = model;
    this.save();
  }

  setRepo(agentId: string, repo: string): void {
    const agent = this.ensureAgent(agentId);
    agent.repo = repo;
    this.save();
  }

  setPermissionMode(agentId: string, mode: string): void {
    const agent = this.ensureAgent(agentId);
    agent.permissionMode = mode;
    this.save();
  }

  updateLastActivity(agentId: string): void {
    const agent = this.ensureAgent(agentId);
    agent.lastActivity = new Date().toISOString();
    this.save();
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

export function computeProjectSlug(repoPath: string): string {
  // CC stores at ~/.claude/projects/<slug>/sessions/
  // Slug is the path with / replaced by - and leading -
  return repoPath.replace(/\//g, '-');
}

// ── CC Session Discovery ──

export interface DiscoveredSession {
  id: string;
  title: string;
  model: string | null;
  mtime: Date;
  lineCount: number;
  contextPct: number | null; // percentage of 200k context used
}

/**
 * Discover CC sessions from ~/.claude/projects/<slug>/*.jsonl
 * Returns the most recent sessions sorted by modification time.
 */
export function discoverCCSessions(repo: string, limit = 10): DiscoveredSession[] {
  const slug = computeProjectSlug(repo);
  const projectDir = join(homedir(), '.claude', 'projects', slug);

  if (!existsSync(projectDir)) return [];

  const results: DiscoveredSession[] = [];

  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return [];
  }

  const now = Date.now();
  const maxAgeMs = 30 * 24 * 60 * 60 * 1000; // 30 days

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    // Skip agent-* sessions (sub-agents)
    if (entry.startsWith('agent-')) continue;

    const fullPath = join(projectDir, entry);
    try {
      const st = statSync(fullPath);

      // Skip too old
      if (now - st.mtimeMs > maxAgeMs) continue;

      const id = entry.replace('.jsonl', '');
      const { title, model } = extractSessionMeta(fullPath, st.size);

      // Skip sessions with no real user messages
      if (title === 'untitled') continue;

      const contextPct = extractContextPct(fullPath, st.size);

      results.push({
        id,
        title,
        model,
        mtime: st.mtime,
        lineCount: countLines(fullPath),
        contextPct,
      });
    } catch {
      continue;
    }
  }

  // Sort by most recent first, take top N
  return results
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, limit);
}

function extractSessionMeta(jsonlPath: string, fileSize: number): { title: string; model: string | null } {
  let title = 'untitled';
  let model: string | null = null;

  // Read last ~4KB for model FIRST (from last assistant message)
  try {
    const fd = openSync(jsonlPath, 'r');
    const readSize = Math.min(4096, fileSize);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, Math.max(0, fileSize - readSize));
    closeSync(fd);

    const text = buf.toString('utf-8');
    const lines = text.split('\n').filter(l => l.includes('"model"')).reverse();
    for (const line of lines) {
      try {
        const start = line.indexOf('{');
        if (start < 0) continue;
        const parsed = JSON.parse(line.slice(start));
        const m = parsed?.message?.model;
        if (m) { model = m; break; }
      } catch { continue; }
    }
  } catch {}

  // Read in growing chunks to find title (first real user message)
  try {
    const fd = openSync(jsonlPath, 'r');
    let offset = 0;
    const chunkSize = 65536; // 64KB chunks
    const maxRead = 2 * 1024 * 1024; // Stop after 2MB
    let accumulated = '';

    while (offset < maxRead) {
      const buf = Buffer.alloc(Math.min(chunkSize, maxRead - offset));
      const bytesRead = readSync(fd, buf, 0, buf.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      accumulated += buf.subarray(0, bytesRead).toString('utf-8');

      // Process complete lines
      const lines = accumulated.split('\n');
      // Keep last incomplete line for next iteration
      accumulated = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        // Quick skip for huge non-user lines
        if (line.startsWith('{"type":"file-history-snapshot"')) continue;

        try {
          const parsed = JSON.parse(line);
          let candidate = '';

          if (parsed.type === 'queue-operation' && parsed.operation === 'enqueue' && parsed.content) {
            candidate = truncTitle(String(parsed.content));
          }
          if (!candidate && parsed.type === 'user' && parsed.message) {
            candidate = extractTitleFromContent(parsed.message.content);
          }
          if (!candidate && parsed.role === 'user' && parsed.content) {
            candidate = extractTitleFromContent(parsed.content);
          }

          if (candidate) { title = candidate; closeSync(fd); return { title, model }; }
        } catch { continue; }
      }
    }
    closeSync(fd);
  } catch {}

  return { title, model };
}

function extractTitleFromContent(content: unknown): string {
  if (typeof content === 'string') return truncTitle(content);
  if (Array.isArray(content)) {
    // Try each text block — skip IDE/system injected ones
    for (const block of content) {
      if (block?.type === 'text' && block.text) {
        const title = truncTitle(block.text);
        if (title) return title;
      }
    }
  }
  return '';
}

function truncTitle(text: string): string {
  // Take first line, strip leading whitespace
  const first = text.split('\n')[0].trim();
  if (!first) return '';
  // Skip system/IDE injected messages
  if (/^<(ide_|system|context|environment_details)/.test(first)) return '';
  return first.length > 60 ? first.slice(0, 57) + '…' : first;
}


function extractContextPct(jsonlPath: string, fileSize: number): number | null {
  try {
    // Read last ~4KB to find the last usage entry
    const fd = openSync(jsonlPath, 'r');
    const readSize = Math.min(4096, fileSize);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, Math.max(0, fileSize - readSize));
    closeSync(fd);

    const text = buf.toString('utf-8');
    const lines = text.split('\n').filter(l => l.includes('"usage"')).reverse();

    for (const line of lines) {
      try {
        const start = line.indexOf('{');
        if (start < 0) continue;
        const parsed = JSON.parse(line.slice(start));
        const usage = parsed?.message?.usage;
        const model: string = parsed?.message?.model ?? '';
        if (!usage) continue;
        const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
        if (input > 0) return Math.round(input / 200_000 * 100);
      } catch {
        continue;
      }
    }
  } catch {}
  return null;
}

function countLines(filePath: string): number {
  try {
    const st = statSync(filePath);
    // Estimate: ~500 bytes per line for JSONL
    return Math.max(1, Math.round(st.size / 500));
  } catch {
    return 0;
  }
}
