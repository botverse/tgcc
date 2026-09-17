// tests/monitor-redact.test.ts
//
// Regression coverage for src/monitor-redact.ts — acceptance criterion 6 ("Every secret
// pattern listed [in PLAN.md § Secret redaction] is redacted, covered by fixtures").
//
// All fixture values below are OBVIOUSLY FAKE: publicly-documented AWS example placeholders
// (AKIAIOSFODNN7EXAMPLE / wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY, from AWS's own docs),
// or ad hoc "EXAMPLE"/"Fake" strings that don't resemble any real credential. Never real-looking.
//
// Note on tag preservation: the module's header comment claims "more specific patterns run
// first so their tag is preserved" before the generic catch-all runs. That holds when the
// secret appears bare, but NOT when it's immediately preceded by a `word:`/`word=` label whose
// word itself ends in KEY/SECRET/TOKEN/PASSWORD (e.g. "aws_secret_access_key=...", "access
// key: AKIA...") — the generic rule re-matches its own already-redacted output and overwrites
// the specific `[REDACTED:xxx]` tag with a plain `[REDACTED]`. The raw secret is still fully
// redacted either way (the security property this criterion cares about), so these tests assert
// on "the raw secret is gone" rather than pinning a specific tag whenever the fixture is in that
// label-shaped form. See the accompanying report to the lead for this doc-vs-behavior note —
// it is not a redaction failure.

import { describe, it, expect } from 'vitest';
import { redactSecrets, REDACTION_RULES } from '../src/monitor-redact.js';

describe('redactSecrets — every named pattern category', () => {
  it('redacts an AWS access key id (AKIA...) when bare', () => {
    const out = redactSecrets('my key id is AKIAIOSFODNN7EXAMPLE, please rotate it');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('[REDACTED:aws-access-key-id]');
  });

  it('redacts an AWS access key id (ASIA... temporary/STS form)', () => {
    const out = redactSecrets('temp creds: ASIAIOSFODNN7EXAMPLE in use');
    expect(out).not.toContain('ASIAIOSFODNN7EXAMPLE');
    expect(out).toContain('[REDACTED');
  });

  it('redacts an aws_secret_access_key assignment (raw value never leaks)', () => {
    const raw = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const out = redactSecrets(`export AWS_SECRET_ACCESS_KEY=${raw}`);
    expect(out).not.toContain(raw);
    expect(out).toContain('[REDACTED');
  });

  it('redacts a sk-... style secret key (OpenAI/Anthropic shape)', () => {
    const out = redactSecrets('bearer sk-EXAMPLE1234567890ABCDEFghijklmnop in header');
    expect(out).not.toContain('sk-EXAMPLE1234567890ABCDEFghijklmnop');
    expect(out).toContain('[REDACTED:sk-key]');
  });

  it('redacts a GitHub personal access token (ghp_...)', () => {
    const out = redactSecrets('token=ghp_EXAMPLE1234567890abcdefghijklmnopqrst');
    expect(out).not.toContain('ghp_EXAMPLE1234567890abcdefghijklmnopqrst');
  });

  it('redacts a GitHub fine-grained PAT (github_pat_...)', () => {
    const out = redactSecrets('using github_pat_EXAMPLE1234567890abcdefghijklmnopqrst11 today');
    expect(out).not.toContain('github_pat_EXAMPLE1234567890abcdefghijklmnopqrst11');
    expect(out).toContain('[REDACTED:github-token]');
  });

  it('redacts a Slack bot token (xoxb-...)', () => {
    const out = redactSecrets('slack: xoxb-EXAMPLE1234567890-FAKEFAKEFAKE');
    expect(out).not.toContain('xoxb-EXAMPLE1234567890-FAKEFAKEFAKE');
    expect(out).toContain('[REDACTED:slack-token]');
  });

  it('redacts a Slack app/user token variant (xoxp-...)', () => {
    const out = redactSecrets('legacy xoxp-EXAMPLE1234567890-FAKEFAKEFAKE token');
    expect(out).not.toContain('xoxp-EXAMPLE1234567890-FAKEFAKEFAKE');
  });

  it('redacts a JWT (header.payload.signature)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKESIGNATUREFAKESIGNATURE';
    const out = redactSecrets(`Authorization: Bearer ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain('[REDACTED:jwt]');
  });

  it('redacts a PEM private key block, including its multi-line body', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfakefakefakefakefakefakefakefake==\nMoreFakeBase64LinesHereFakeFakeFake==\n-----END RSA PRIVATE KEY-----';
    // Deliberately NOT preceded by a "...key:" label — see the module-level comment above about
    // the generic catch-all re-matching and overwriting an already-specific tag in that case.
    const out = redactSecrets(`here is the credential file:\n${pem}\nend of file`);
    expect(out).not.toContain('MIIEowIBAAKCAQEAfakefakefakefakefakefakefakefake==');
    expect(out).not.toContain('MoreFakeBase64LinesHereFakeFakeFake==');
    expect(out).toContain('[REDACTED:private-key-block]');
  });

  it('redacts a generic OPENSSH PRIVATE KEY block variant', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakefakefakefakefakefakefake\n-----END OPENSSH PRIVATE KEY-----';
    const out = redactSecrets(pem);
    expect(out).not.toContain('fakefakefakefakefakefakefake');
  });

  describe('generic *_KEY= / *_SECRET= / *TOKEN= / *PASSWORD= catch-all', () => {
    // Regression fixtures for the exact bug noted in work/agent-conversation-monitor/LOG.md:
    // DB_PASSWORD= and API_TOKEN= originally were NOT redacted because the shared regex
    // required a literal "_" before KEY/_SECRET but not before TOKEN/PASSWORD.
    it('redacts DB_PASSWORD=...', () => {
      const out = redactSecrets('DB_PASSWORD=SuperFakeSecret123');
      expect(out).not.toContain('SuperFakeSecret123');
      expect(out).toContain('[REDACTED]');
    });

    it('redacts API_TOKEN=...', () => {
      const out = redactSecrets('API_TOKEN=AnotherFakeToken456');
      expect(out).not.toContain('AnotherFakeToken456');
      expect(out).toContain('[REDACTED]');
    });

    it('redacts MY_SECRET_KEY=...', () => {
      const out = redactSecrets('MY_SECRET_KEY=ThirdFakeValue789');
      expect(out).not.toContain('ThirdFakeValue789');
      expect(out).toContain('[REDACTED]');
    });

    it('redacts a colon-style assignment (not just "=")', () => {
      const out = redactSecrets('password: FakeColonSecretValue111');
      expect(out).not.toContain('FakeColonSecretValue111');
    });

    // Fixed by monitor-src in 16a87c4 after this repro was reported: the generic catch-all's
    // prefix group [A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD) needed an optional ['"]? right
    // after it to tolerate a JSON/dict-style quoted key ("apiKey": "value" / 'apiKey': 'value')
    // — the closing quote used to sit between the key and the separator and break the match.
    it('redacts a quoted assignment in JSON-style text (spaced)', () => {
      const out = redactSecrets('{"apiKey": "FakeJsonSecretValue000"}');
      expect(out).not.toContain('FakeJsonSecretValue000');
    });

    it('redacts a quoted assignment in JSON-style text (no space after colon)', () => {
      const out = redactSecrets('{"apiKey":"FakeJsonSecretValueNoSpace"}');
      expect(out).not.toContain('FakeJsonSecretValueNoSpace');
    });

    it('redacts a Python-dict-style single-quoted assignment', () => {
      const out = redactSecrets("{'api_key': 'FakePySecretValue000'}");
      expect(out).not.toContain('FakePySecretValue000');
    });

    it('redacts camelCase JSON field names (accessToken, secretAccessKey, serviceRoleKey)', () => {
      expect(redactSecrets('{"accessToken": "FakeAccessToken000"}')).not.toContain('FakeAccessToken000');
      expect(redactSecrets('{"secretAccessKey": "FakeSecretAccessKey222"}')).not.toContain('FakeSecretAccessKey222');
      expect(redactSecrets('{"serviceRoleKey": "FakeServiceRoleKey333"}')).not.toContain('FakeServiceRoleKey333');
    });

    it('redacts snake_case JSON field names (client_secret)', () => {
      expect(redactSecrets('{"client_secret": "FakeClientSecret111"}')).not.toContain('FakeClientSecret111');
    });
  });

  describe('realistic credential-file and tool-output formats (sentinella_team ~/.aws, kyo_team Supabase env)', () => {
    it('redacts every field in an ~/.aws/credentials-style INI block (access key id, secret key, session token)', () => {
      // AWS access key ids are a fixed 20 chars (AKIA/ASIA + 16) — this fixture respects that
      // length so it actually exercises the aws-access-key-id rule's \b...{16}\b pattern; a
      // shorter/longer fake value would silently fall through to the generic rule instead and
      // give a false read on whether the SPECIFIC rule works.
      const ini = [
        '[default]',
        'aws_access_key_id = AKIAEXAMPLE000000000',
        'aws_secret_access_key = wJalrEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPL',
        'aws_session_token = EXAMPLEsessiontokenEXAMPLE',
      ].join('\n');
      const out = redactSecrets(ini);
      expect(out).not.toContain('AKIAEXAMPLE000000000');
      expect(out).not.toContain('wJalrEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPL');
      expect(out).not.toContain('EXAMPLEsessiontokenEXAMPLE');
    });

    it('redacts a YAML-style password field', () => {
      expect(redactSecrets('password: EXAMPLEPASS5')).not.toContain('EXAMPLEPASS5');
    });

    it('redacts a YAML-style api_key field', () => {
      expect(redactSecrets('api_key: EXAMPLEKEY6')).not.toContain('EXAMPLEKEY6');
    });

    it('redacts a YAML-style client_secret field', () => {
      expect(redactSecrets('client_secret: EXAMPLESECRET7')).not.toContain('EXAMPLESECRET7');
    });

    it('redacts a shell "export API_KEY=..." assignment', () => {
      expect(redactSecrets('export API_KEY="EXAMPLEKEY8"')).not.toContain('EXAMPLEKEY8');
    });
  });

  // Fixed by monitor-src in f1d94d4 after these repros were reported (round 5, following the
  // lead's request for realistic ~/.aws and Supabase-connection-string formats): neither shape
  // has a KEY/SECRET/TOKEN/PASSWORD-named field to key off, so the generic catch-all could never
  // have caught them — both needed dedicated rules.
  describe('connection-string embedded passwords (dedicated rule, host/user/db stay visible)', () => {
    it('redacts the password in a postgresql:// connection string, but the host may stay', () => {
      const out = redactSecrets('DATABASE_URL=postgresql://postgres:EXAMPLEPASS@db.example.supabase.co:5432/postgres');
      expect(out).not.toContain('EXAMPLEPASS');
      expect(out).toContain('db.example.supabase.co'); // only the password needs scrubbing
    });

    it('redacts the password in a mysql:// connection string', () => {
      const out = redactSecrets('mysql://root:EXAMPLEPASS2@localhost:3306/mydb');
      expect(out).not.toContain('EXAMPLEPASS2');
    });

    it('redacts the password in a redis:// connection string (no username)', () => {
      const out = redactSecrets('redis://:EXAMPLEPASS3@redis-host:6379');
      expect(out).not.toContain('EXAMPLEPASS3');
    });

    it('redacts the password in a mongodb+srv:// connection string', () => {
      const out = redactSecrets('mongodb+srv://user:EXAMPLEPASS4@cluster0.example.mongodb.net/mydb');
      expect(out).not.toContain('EXAMPLEPASS4');
    });

    it('leaves a credential-free URL completely unchanged (no over-matching)', () => {
      const url = 'see https://api.example.com/v1/status and https://docs.example.com/guide for details';
      expect(redactSecrets(url)).toBe(url);
    });
  });

  describe('opaque (non-JWT) Authorization: Bearer tokens (dedicated rule)', () => {
    it('redacts an opaque bearer token in a curl Authorization header (a Bash tool INPUT, not just a result)', () => {
      const out = redactSecrets('curl -H "Authorization: Bearer abcDEF123opaqueTokenNotAJWT456xyz" https://api.example.com');
      expect(out).not.toContain('abcDEF123opaqueTokenNotAJWT456xyz');
    });

    it('still redacts (via the more specific jwt rule) when the bearer token IS JWT-shaped', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKESIGNATUREFAKESIGNATURE';
      const out = redactSecrets(`Authorization: Bearer ${jwt}`);
      expect(out).not.toContain(jwt);
    });
  });

  it('handles multiple distinct secrets in one string, redacting all of them', () => {
    const out = redactSecrets('multiple secrets: AKIAIOSFODNN7EXAMPLE and DB_PASSWORD=Fake123Pass in one string');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('Fake123Pass');
  });

  it('leaves ordinary text with no secret-shaped content unchanged', () => {
    const text = 'just some normal text with no secrets, discussing the weather';
    expect(redactSecrets(text)).toBe(text);
  });

  it('returns falsy input unchanged (empty string) without throwing', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('never throws on adversarial input (very long string, regex-hostile repeats)', () => {
    const hostile = 'KEY='.repeat(500) + 'x'.repeat(5000);
    expect(() => redactSecrets(hostile)).not.toThrow();
  });

  it('every rule name in REDACTION_RULES is unique (sanity check on the rule table itself)', () => {
    const names = REDACTION_RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
