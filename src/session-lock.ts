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
 * Decide whether a session is being actively used by a process OTHER than this TGCC process.
 * Returns true if it looks like an interactive `claude` session is currently writing to the JSONL.
 *
 * Signal combo:
 *   - No lock from us with a live pid → we're not the owner
 *   - AND JSONL was written within recentWindowMs → SOMEONE is actively writing
 *   → assume external owner (interactive claude in a terminal). Don't resume.
 */
export function isSessionExternallyActive(
  sessionId: string,
  jsonlPath: string,
  recentWindowMs = 60_000,
): boolean {
  // Check if a lock from THIS tgcc process exists and is live
  try {
    const p = lockPath(sessionId);
    if (existsSync(p)) {
      const lock = JSON.parse(readFileSync(p, 'utf-8')) as SessionLock;
      if (lock.pid === process.pid && pidAlive(lock.pid)) {
        return false; // we own it, safe
      }
      // Other-pid lock: if that pid is alive, treat as another tgcc instance? Unlikely with
      // systemd-managed single instance. Fall through to mtime check.
    }
  } catch { /* fall through */ }

  // No live lock from us — check JSONL recency
  try {
    if (!existsSync(jsonlPath)) return false;
    const st = statSync(jsonlPath);
    const ageMs = Date.now() - st.mtimeMs;
    return ageMs < recentWindowMs;
  } catch {
    return false;
  }
}
