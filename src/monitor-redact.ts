// ── Conversation monitor: secret redaction ──
//
// Content mirrored into the monitor group goes into a Telegram cloud chat, which is not
// end-to-end encrypted, and monitored agents handle real credentials (sentinella_team mounts
// ~/.aws; kyo_team has Supabase keys in its environment). Every pattern the monitor scrubs
// before mirroring lives HERE and only here, so the list can grow without hunting through the
// rest of the module for a second copy. Redaction is a mitigation, not a guarantee — the
// monitor destination must stay private to the owner regardless.
//
// See work/agent-conversation-monitor/PLAN.md § Secret redaction for the source list.

type Replacer = (substring: string, ...args: unknown[]) => string;

interface RedactionRule {
  name: string;
  pattern: RegExp;
  replace: string | Replacer;
}

// Order matters: more specific patterns run first so their [REDACTED:xxx] tag is preserved;
// the generic *_KEY=/*_SECRET=/*TOKEN=/*PASSWORD= rule runs last as a catch-all.
const REDACTION_RULES: RedactionRule[] = [
  // AWS access key IDs (AKIA... long-term, ASIA... temporary/STS)
  {
    name: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: '[REDACTED:aws-access-key-id]',
  },
  // AWS secret access key assignments (40 base64-ish chars)
  {
    name: 'aws-secret-key',
    pattern: /\b((?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY))\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/g,
    replace: ((_m: string, key: string) => `${key}=[REDACTED:aws-secret-key]`) as Replacer,
  },
  // OpenAI/Anthropic-style secret keys (sk-...)
  {
    name: 'sk-key',
    pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    replace: '[REDACTED:sk-key]',
  },
  // GitHub personal access tokens
  {
    name: 'github-token',
    pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g,
    replace: '[REDACTED:github-token]',
  },
  // Slack tokens (bot/app/user)
  {
    name: 'slack-token',
    pattern: /\bxox[bap]-[A-Za-z0-9-]{10,}\b/g,
    replace: '[REDACTED:slack-token]',
  },
  // JWTs (header.payload.signature, base64url segments)
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replace: '[REDACTED:jwt]',
  },
  // PEM private key blocks
  {
    name: 'pem-private-key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: '[REDACTED:private-key-block]',
  },
  // Generic *_KEY= / *_SECRET= / *TOKEN= / *PASSWORD= assignments (catch-all, runs last)
  {
    name: 'generic-secret-assignment',
    // Prefix allows underscores too (DB_PASSWORD, API_TOKEN, AWS_SECRET_ACCESS_KEY, ...) —
    // the suffix itself no longer needs its own leading underscore.
    pattern: /\b([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD))\s*[:=]\s*['"]?([^\s'",]{4,})['"]?/gi,
    replace: ((_m: string, key: string) => `${key}=[REDACTED]`) as Replacer,
  },
];

/** Redact every known secret pattern from mirrored text. Never throws. If redaction itself
 *  fails unexpectedly, fail CLOSED — withhold the content rather than mirror it unredacted,
 *  since a monitor bug leaking a real credential is worse than a dropped mirror line. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  try {
    let out = text;
    for (const rule of REDACTION_RULES) {
      out = out.replace(rule.pattern, rule.replace as Replacer);
    }
    return out;
  } catch {
    return '[REDACTION FAILED — content withheld]';
  }
}

export { REDACTION_RULES };
