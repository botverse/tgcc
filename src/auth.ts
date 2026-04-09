// ── OAuth Auth Fallback ──
//
// Detects 401/auth errors from CC and runs `claude auth login` interactively
// via Telegram: sends the OAuth URL to the user, waits for the auth code reply,
// pipes it to `claude auth login` stdin, then retries the original task.
//
// This module does NOT directly manipulate tokens — it delegates to CC's own
// auth command to stay within Anthropic's intended usage patterns.

import { spawn } from 'node:child_process';
import type pino from 'pino';
import type { TelegramBot } from './telegram.js';

// ── Auth error detection ──

const AUTH_ERROR_PATTERNS = [
  /oauth token has expired/i,
  /authentication failed/i,
  /invalid authorization code/i,
  /unauthorized/i,
  /token.*revoked/i,
];

/** Check if an API error event indicates an auth failure. */
export function isAuthError(status?: number, message?: string): boolean {
  if (status === 401 || status === 403) return true;
  if (message) {
    return AUTH_ERROR_PATTERNS.some(p => p.test(message));
  }
  return false;
}

/** Check if a result event's errors array contains auth-related messages. */
export function resultHasAuthError(errors?: string[]): boolean {
  if (!errors) return false;
  return errors.some(e => AUTH_ERROR_PATTERNS.some(p => p.test(e)));
}

// ── Auth flow ──

export interface AuthFlowOptions {
  ccBinaryPath: string;
  chatId: number;
  tgBot: TelegramBot;
  timeoutMs: number;
  logger: pino.Logger;
}

export interface AuthFlowResult {
  success: boolean;
  error?: string;
}

/**
 * Run the OAuth auth flow via Telegram:
 * 1. Spawn `claude auth login`
 * 2. Extract the OAuth URL from its output
 * 3. Send it to the user via Telegram
 * 4. Wait for the user to reply with the auth code
 * 5. Pipe the code to the process stdin
 * 6. Wait for the process to exit
 */
export async function runAuthFlow(opts: AuthFlowOptions): Promise<AuthFlowResult> {
  const { ccBinaryPath, chatId, tgBot, timeoutMs, logger } = opts;

  logger.info({ chatId }, 'Starting OAuth auth flow');

  // Spawn `claude auth login`
  const proc = spawn(ccBinaryPath, ['auth', 'login'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  // Wait for the OAuth URL to appear in output
  const url = await waitForUrl(proc, 15_000);

  if (!url) {
    proc.kill();
    const errDetail = stderr || stdout || 'no output';
    logger.error({ errDetail }, 'No OAuth URL found in claude auth login output');
    return { success: false, error: `Could not extract auth URL from claude output: ${errDetail.slice(0, 200)}` };
  }

  // Send URL to user
  await tgBot.sendText(
    chatId,
    `🔑 <b>Claude needs re-authentication.</b>\n\nTap to sign in: ${url}\n\nAfter signing in, reply with the authorization code.`,
    'HTML',
  );

  // Wait for the user's reply with the auth code
  const code = await tgBot.waitForMessage(chatId, timeoutMs);

  if (!code) {
    proc.kill();
    await tgBot.sendText(chatId, '⚠️ Auth timed out — no code received. Use /auth to retry.', 'HTML');
    return { success: false, error: 'Auth code timeout' };
  }

  // Pipe the code to claude auth login stdin
  proc.stdin.write(code + '\n');
  proc.stdin.end();

  // Wait for the process to exit
  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 30_000); // 30s to complete auth exchange

    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  if (exitCode === 0) {
    await tgBot.sendText(chatId, '✅ Authenticated. Retrying your task...', 'HTML');
    logger.info('OAuth auth flow completed successfully');
    return { success: true };
  }

  const errMsg = stderr || stdout || `exit code ${exitCode}`;
  await tgBot.sendText(chatId, `❌ Auth failed: ${errMsg.slice(0, 200)}. Use /auth to try again.`, 'HTML');
  logger.error({ exitCode, stderr: stderr.slice(0, 500) }, 'OAuth auth flow failed');
  return { success: false, error: errMsg.slice(0, 200) };
}

// ── Helpers ──

const OAUTH_URL_RE = /https:\/\/(?:claude\.ai|console\.anthropic\.com)\/oauth\/authorize\S+/;

function waitForUrl(proc: ReturnType<typeof spawn>, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let output = '';
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    }, timeoutMs);

    const check = (chunk: Buffer) => {
      if (resolved) return;
      output += chunk.toString();
      const match = output.match(OAUTH_URL_RE);
      if (match) {
        resolved = true;
        clearTimeout(timer);
        resolve(match[0]);
      }
    };

    proc.stdout!.on('data', check);
    proc.stderr!.on('data', check);

    proc.on('exit', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        // One last check
        const match = output.match(OAUTH_URL_RE);
        resolve(match ? match[0] : null);
      }
    });
  });
}
