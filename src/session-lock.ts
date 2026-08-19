import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOCK_DIR = join(homedir(), '.tgcc', 'session-locks');

interface SessionLock {
  pid: number;
  agentId: string;
  startedAt: number;
}

function lockPath(sessionId: string): string {
  return join(LOCK_DIR, `${sessionId}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

/** Write a lock file claiming ownership of sessionId. Overwrites any stale lock. */
export function acquireSessionLock(sessionId: string, agentId: string): void {
  try {
    if (!existsSync(LOCK_DIR)) mkdirSync(LOCK_DIR, { recursive: true });
    const lock: SessionLock = { pid: process.pid, agentId, startedAt: Date.now() };
    writeFileSync(lockPath(sessionId), JSON.stringify(lock));
  } catch { /* non-fatal */ }
}

/** Remove the lock file if it exists and is owned by us. */
export function releaseSessionLock(sessionId: string): void {
  try {
    const p = lockPath(sessionId);
    if (!existsSync(p)) return;
    const lock = JSON.parse(readFileSync(p, 'utf-8')) as SessionLock;
    if (lock.pid !== process.pid) return; // not ours; leave it
    unlinkSync(p);
  } catch { /* non-fatal */ }
}

/**
 * Decide whether a session is being actively used by a process OTHER than this TGCC agent.
 * Returns true if it looks like an interactive `claude` session is currently writing to the JSONL.
 *
 * Signal combo:
 *   - No lock owned by this tgcc agent
 *   - AND JSONL was written within recentWindowMs → SOMEONE is actively writing
 *   → assume external owner (interactive claude in a terminal). Don't resume.
 *
 * A lock whose `agentId` matches ours always means the session is ours — either the
 * current process or a previous instance from before a restart. Its pid may be dead
 * (restart) but the recent JSONL writes were TGCC's own, not an external `claude`.
 */
export function isSessionExternallyActive(
  sessionId: string,
  jsonlPath: string,
  agentId: string,
  recentWindowMs = 60_000,
): boolean {
  // Check the lock file for this session.
  try {
    const p = lockPath(sessionId);
    if (existsSync(p)) {
      const lock = JSON.parse(readFileSync(p, 'utf-8')) as SessionLock;
      // A lock owned by THIS tgcc agent means the session is ours — current process or
      // a previous instance before a restart. Either way it's safe to resume; never
      // treat our own session as externally owned (this is the post-restart case).
      if (lock.agentId === agentId) {
        return false;
      }
      // Lock owned by a different agent with a live pid → genuinely in use elsewhere.
      if (pidAlive(lock.pid)) {
        return true;
      }
      // Stale lock from another agent (dead pid) → fall through to the mtime check.
    }
  } catch { /* fall through */ }

  // No lock we recognize — an interactive `claude` in a terminal leaves no lock file,
  // so a recently-written JSONL means someone external is actively using it.
  try {
    if (!existsSync(jsonlPath)) return false;
    const st = statSync(jsonlPath);
    const ageMs = Date.now() - st.mtimeMs;
    return ageMs < recentWindowMs;
  } catch {
    return false;
  }
}
