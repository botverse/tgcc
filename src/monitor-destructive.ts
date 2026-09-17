// ── Conversation monitor: destructive-action flagging ──
//
// Pattern match on tool inputs, as an attention aid only — the monitor mirrors every tool call
// regardless of a match; a missed pattern loses the ⚠️ flag, not the event itself. Every pattern
// lives HERE and only here, so the list can grow without hunting for a second copy elsewhere.
//
// See work/agent-conversation-monitor/PLAN.md § Destructive-action flagging for the source list.

/** Simple regex checks against the tool input flattened to a single string (covers Bash
 *  `command`, and any other tool whose relevant field isn't named `command`). */
const DESTRUCTIVE_TEXT_PATTERNS: RegExp[] = [
  // rm -r / rm -rf (any flag cluster containing r, or --recursive)
  /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*\b|--recursive\b)/i,
  // git push --force / -f / --force-with-lease
  /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?\b|\s-f\b)/i,
  // git reset --hard
  /\bgit\s+reset\s+--hard\b/i,
  // git clean -fd (either flag order)
  /\bgit\s+clean\s+-[a-zA-Z]*(?:fd|df)[a-zA-Z]*\b/i,
  // git branch -D
  /\bgit\s+branch\s+.*-D\b/i,
  // DROP TABLE|DATABASE|SCHEMA
  /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
  // TRUNCATE
  /\bTRUNCATE\b/i,
  // docker rm|rmi|system prune|volume rm
  /\bdocker\s+(?:rm|rmi|system\s+prune|volume\s+rm)\b/i,
  // systemctl stop|disable
  /\bsystemctl\s+(?:stop|disable)\b/i,
  // kill -9
  /\bkill\s+(?:-9|-s\s*KILL|-SIGKILL)\b/i,
  // chmod -R 777
  /\bchmod\s+-R\s+777\b/i,
  // mkfs
  /\bmkfs(?:\.\w+)?\b/i,
  // dd of=
  /\bdd\b[^\n]*\bof=/i,
  // aws s3 rm|rb
  /\baws\s+s3\s+(?:rm|rb)\b/i,
  // supabase db reset
  /\bsupabase\s+db\s+reset\b/i,
];

/** DELETE FROM without a WHERE clause — needs presence-of-one-absence-of-other, not a single regex. */
function isUnguardedDelete(text: string): boolean {
  return /\bDELETE\s+FROM\b/i.test(text) && !/\bWHERE\b/i.test(text);
}

/** File paths that look like credentials/secrets — flagged when Write/Edit targets them. */
const CREDENTIAL_FILE_PATTERN = /(^|[\\/])\.env(\.[\w.-]+)?$|(^|[\\/])credentials(\.\w+)?$|\.pem$|id_rsa(\.\w+)?$|(^|[\\/])secrets?\.(json|ya?ml)$/i;
const FILE_EDITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const FILE_PATH_KEYS = ['file_path', 'path', 'notebook_path'];

function flattenForMatch(input: unknown, depth = 0): string {
  if (input == null || depth > 6) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  if (Array.isArray(input)) return input.map((v) => flattenForMatch(v, depth + 1)).join(' ');
  if (typeof input === 'object') {
    return Object.values(input as Record<string, unknown>)
      .map((v) => flattenForMatch(v, depth + 1))
      .join(' ');
  }
  return '';
}

function editTargetsCredentialFile(toolName: string, input: Record<string, unknown>): boolean {
  if (!FILE_EDITING_TOOLS.has(toolName)) return false;
  for (const key of FILE_PATH_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && CREDENTIAL_FILE_PATTERN.test(v)) return true;
  }
  return false;
}

/** True if a tool call's input matches any destructive pattern. Attention aid only —
 *  the caller mirrors the event either way; this only controls the ⚠️ flag. Never throws. */
export function isDestructiveToolCall(toolName: string, input: unknown): boolean {
  try {
    const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (editTargetsCredentialFile(toolName, record)) return true;
    const flat = flattenForMatch(input);
    if (!flat) return false;
    if (isUnguardedDelete(flat)) return true;
    return DESTRUCTIVE_TEXT_PATTERNS.some((re) => re.test(flat));
  } catch {
    return false;
  }
}

export { DESTRUCTIVE_TEXT_PATTERNS, CREDENTIAL_FILE_PATTERN };
