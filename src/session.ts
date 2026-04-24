import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
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
 * For shared agents with isolated CLAUDE_CONFIG_DIR, pass configDir to look there instead.
 */
export function getSessionJsonlPath(sessionId: string, repo: string, configDir?: string): string {
  const slug = computeProjectSlug(repo);
  const base = configDir ?? join(homedir(), '.claude');
  return join(base, 'projects', slug, `${sessionId}.jsonl`);
}

const MAX_SLUG_LENGTH = 50;

export function computeProjectSlug(repoPath: string): string {
  // Match CC's sanitizePath logic: replace / and . with -, truncate long paths with hash suffix
  const base = repoPath.replace(/[/.]/g, '-');
  if (base.length <= MAX_SLUG_LENGTH) return base;
  const hash = createHash('sha256').update(repoPath).digest('hex').slice(0, 8);
  return base.slice(0, MAX_SLUG_LENGTH - 9) + '-' + hash;
}

// ── CC Session Discovery ──

export type SessionEndState = 'completed' | 'interrupted' | 'unknown';

export interface DiscoveredSession {
  id: string;
  title: string;
  summary: string | null;      // AI-generated session summary (from compaction or last assistant turn)
  model: string | null;
  mtime: Date;
  lineCount: number;
  contextPct: number | null; // percentage of 200k context used
  endState: SessionEndState;
}

/**
 * Discover CC sessions from ~/.claude/projects/<slug>/*.jsonl
 * Returns the most recent sessions sorted by modification time.
 */
export function discoverCCSessions(repo: string, limit = 10, configDir?: string): DiscoveredSession[] {
  const slug = computeProjectSlug(repo);
  const base = configDir ?? join(homedir(), '.claude');
  const projectDir = join(base, 'projects', slug);

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

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    // Skip agent-* sessions (sub-agents)
    if (entry.startsWith('agent-')) continue;

    const id = entry.replace('.jsonl', '');
    // Validate UUID format (CC only accepts valid UUIDs)
    if (!UUID_RE.test(id)) continue;

    const fullPath = join(projectDir, entry);
    try {
      const st = statSync(fullPath);

      // Skip too old
      if (now - st.mtimeMs > maxAgeMs) continue;

      // Skip sidechain sessions (sub-agent transcript forks)
      if (isSidechainSession(fullPath)) continue;

      const { title, model } = extractSessionMeta(fullPath, st.size);

      // Skip sessions with no real user messages
      if (title === 'untitled') continue;

      // Skip ephemeral agent sessions (ralph, etc.) that share the same project dir
      if (title.startsWith('You are Ralph')) continue;

      const contextPct = extractContextPct(fullPath, st.size);
      const endState = getSessionEndState(fullPath, st.size);
      const summary = extractSessionSummary(fullPath, st.size);

      results.push({
        id,
        title,
        summary,
        model,
        mtime: st.mtime,
        lineCount: countLines(fullPath),
        contextPct,
        endState,
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

function isSidechainSession(jsonlPath: string): boolean {
  try {
    const fd = openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(512);
    const bytesRead = readSync(fd, buf, 0, 512, 0);
    closeSync(fd);
    if (bytesRead === 0) return false;
    const firstLine = buf.subarray(0, bytesRead).toString('utf-8').split('\n')[0];
    return firstLine.includes('"isSidechain":true') || firstLine.includes('"isSidechain": true');
  } catch {
    return false;
  }
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

/** Extract an AI-generated session summary.
 *  Priority: (1) last compaction summary, (2) last assistant text snippet. */
function extractSessionSummary(jsonlPath: string, fileSize: number): string | null {
  // Read last ~64KB — compaction summaries and recent assistant turns are near the end
  const readSize = Math.min(65536, fileSize);
  let text: string;
  try {
    const fd = openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, Math.max(0, fileSize - readSize));
    closeSync(fd);
    text = buf.toString('utf-8');
  } catch {
    return null;
  }

  const lines = text.split('\n');

  // Walk backwards — find the most recent compaction summary or assistant text
  let lastAssistantText: string | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;

    try {
      // Quick checks before parsing
      if (line.includes('isCompactSummary')) {
        const parsed = JSON.parse(line.indexOf('{') >= 0 ? line.slice(line.indexOf('{')) : line);
        const content = parsed?.message?.content;
        if (content) {
          const summaryText = typeof content === 'string' ? content
            : Array.isArray(content) ? content.find((b: { type?: string; text?: string }) => b?.type === 'text')?.text ?? null
            : null;
          if (summaryText) return extractCompactSummarySnippet(summaryText);
        }
      }

      // Capture last assistant text (only if we haven't found a compaction summary)
      if (lastAssistantText === null && line.includes('"assistant"') && line.includes('"text"')) {
        const parsed = JSON.parse(line.indexOf('{') >= 0 ? line.slice(line.indexOf('{')) : line);
        if (parsed?.message?.role === 'assistant' || parsed?.role === 'assistant') {
          const content = parsed?.message?.content ?? parsed?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === 'text' && block.text?.trim()) {
                lastAssistantText = block.text.trim();
                break;
              }
            }
          } else if (typeof content === 'string' && content.trim()) {
            lastAssistantText = content.trim();
          }
        }
      }
    } catch { continue; }
  }

  // Fall back to last assistant text — first meaningful line, truncated
  if (lastAssistantText) {
    // Take the first non-empty line that's not a tool-call preamble
    for (const ln of lastAssistantText.split('\n')) {
      const trimmed = ln.trim();
      if (trimmed && !trimmed.startsWith('[') && !trimmed.startsWith('<') && trimmed.length > 5) {
        return trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed;
      }
    }
  }

  return null;
}

/** Extract a short snippet from a compaction summary's Analysis section. */
function extractCompactSummarySnippet(summaryText: string): string {
  // Look for numbered items after "Analysis:" or the summary section
  const lines = summaryText.split('\n');
  const snippetLines: string[] = [];
  let inAnalysis = false;
  let itemCount = 0;

  for (const line of lines) {
    // Start collecting after "Analysis:" or "Summary:" header
    if (/^(Analysis|Summary):/.test(line.trim())) {
      inAnalysis = true;
      continue;
    }
    // Also start after "Primary Request" or "1. " if we haven't found a header
    if (!inAnalysis && /^\d+\.\s/.test(line.trim())) {
      inAnalysis = true;
    }
    if (inAnalysis) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Count numbered items
      if (/^\d+\.\s/.test(trimmed)) {
        itemCount++;
        if (itemCount > 3) break; // take first 3 items
      }
      snippetLines.push(trimmed);
    }
    // Limit total length
    if (snippetLines.join(' ').length > 300) break;
  }

  if (snippetLines.length > 0) {
    const result = snippetLines.join(' ');
    return result.length > 300 ? result.slice(0, 300) + '…' : result;
  }

  // Fallback: first 200 chars of the summary
  const clean = summaryText.replace(/^This session is being continued.*?\n\n/s, '').trim();
  return clean.length > 200 ? clean.slice(0, 200) + '…' : clean;
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
  // Scan line-by-line, skipping IDE/system XML blocks and TGCC-injected preambles
  // to find the actual user text.
  const IDE_OPEN = /^<(ide_\w+|environment_details|system|context|system-reminder|heartbeat_rules)[\s>]/;
  const IDE_CLOSE = /^<\/(ide_\w+|environment_details|system|context|system-reminder|heartbeat_rules)>/;
  // System-injected bracket preambles from TGCC (worker events, context notices, etc.)
  const SYSTEM_PREAMBLE = /^\[(Worker events|Context:|From supervisor|From agent )/;
  let skipDepth = 0;
  let inPreamble = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) { inPreamble = false; continue; } // blank line ends preamble block
    if (IDE_OPEN.test(trimmed)) { skipDepth++; continue; }
    if (IDE_CLOSE.test(trimmed)) { if (skipDepth > 0) skipDepth--; continue; }
    if (skipDepth > 0) continue;
    if (SYSTEM_PREAMBLE.test(trimmed)) { inPreamble = true; continue; }
    if (inPreamble) continue; // skip continuation lines of preamble until blank line
    return trimmed.length > 60 ? trimmed.slice(0, 57) + '…' : trimmed;
  }
  return '';
}


/**
 * Returns true if recent messages in the JSONL contain IDE-injected content
 * (i.e. the session was recently active in VSCode or another IDE plugin).
 */
export function hasIDEContent(jsonlPath: string): boolean {
  try {
    const st = statSync(jsonlPath);
    const readSize = Math.min(8192, st.size);
    const fd = openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, Math.max(0, st.size - readSize));
    closeSync(fd);
    const text = buf.toString('utf-8');
    return text.includes('<ide_') || text.includes('<environment_details');
  } catch {
    return false;
  }
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
        if (input > 0) {
          const contextWindow = getModelContextWindow(model);
          return Math.round(input / contextWindow * 100);
        }
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

export function getSessionEndState(jsonlPath: string, fileSize: number): SessionEndState {
  try {
    const fd = openSync(jsonlPath, 'r');
    const readSize = Math.min(8192, fileSize);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, Math.max(0, fileSize - readSize));
    closeSync(fd);

    const lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
    // Walk backwards to find the last user or assistant entry
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const start = lines[i].indexOf('{');
        if (start < 0) continue;
        const parsed = JSON.parse(lines[i].slice(start));
        const type = parsed.type;
        const role = parsed.message?.role;

        if (type === 'assistant' || role === 'assistant') {
          const stopReason = parsed.message?.stop_reason;
          return stopReason === 'end_turn' ? 'completed' : 'interrupted';
        }
        if (type === 'user' || role === 'user') {
          return 'interrupted'; // CC never responded
        }
      } catch { continue; }
    }
  } catch {}
  return 'unknown';
}

function getModelContextWindow(model: string): number {
  if (!model) return 200_000;
  const m = model.toLowerCase();
  if (m.includes('opus')) return 200_000;
  if (m.includes('sonnet')) return 200_000;
  if (m.includes('haiku')) return 200_000;
  return 200_000; // Safe default
}

// ── Session History Extraction (for Ralph) ──

interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Extract the most recent user/assistant messages from a session JSONL file.
 * Returns a formatted conversation transcript for ralph context injection.
 */
export function extractRecentConversation(jsonlPath: string, maxMessages = 8, maxChars = 6000): string {
  if (!existsSync(jsonlPath)) return '(no session history available)';

  try {
    const st = statSync(jsonlPath);
    const fd = openSync(jsonlPath, 'r');

    // Read last ~128KB to capture recent messages
    const readSize = Math.min(128 * 1024, st.size);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, Math.max(0, st.size - readSize));
    closeSync(fd);

    const text = buf.toString('utf-8');
    const lines = text.split('\n').filter(l => l.trim());

    const messages: ConversationMessage[] = [];

    for (const line of lines) {
      try {
        const start = line.indexOf('{');
        if (start < 0) continue;
        const parsed = JSON.parse(line.slice(start));

        // User messages
        if (parsed.type === 'user' || parsed.role === 'user') {
          const content = parsed.message?.content ?? parsed.content;
          const msgText = extractTextFromContent(content);
          if (msgText) messages.push({ role: 'user', text: msgText });
        }

        // Assistant messages
        if (parsed.type === 'assistant' || parsed.role === 'assistant') {
          const content = parsed.message?.content ?? parsed.content;
          const msgText = extractTextFromContent(content);
          if (msgText) messages.push({ role: 'assistant', text: msgText });
        }
      } catch { continue; }
    }

    if (messages.length === 0) return '(no session history available)';

    // Take last N messages
    const recent = messages.slice(-maxMessages);

    // Format with truncation
    let totalChars = 0;
    const formatted: string[] = [];
    for (const msg of recent) {
      const truncated = msg.text.length > 1000 ? msg.text.slice(0, 1000) + '…' : msg.text;
      totalChars += truncated.length;
      if (totalChars > maxChars) break;
      formatted.push(`[${msg.role}]: ${truncated}`);
    }

    return formatted.join('\n\n');
  } catch {
    return '(failed to read session history)';
  }
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return cleanMessageText(content);
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (block?.type === 'text' && block.text) {
        textParts.push(block.text);
      }
      // Summarize tool_use blocks briefly
      if (block?.type === 'tool_use' && block.name) {
        textParts.push(`[tool: ${block.name}]`);
      }
    }
    return cleanMessageText(textParts.join('\n'));
  }
  return '';
}

function cleanMessageText(text: string): string {
  // Strip IDE XML blocks and system preambles
  return text
    .replace(/<(ide_\w+|environment_details|system-reminder|heartbeat_rules)[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/^\[(Worker events|Context:|From supervisor|From agent )[^\]]*\][^\n]*/gm, '')
    .trim();
}
