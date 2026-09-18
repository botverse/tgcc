// tests/monitor-destructive.test.ts
//
// Regression coverage for src/monitor-destructive.ts — supports acceptance criterion 5
// ("Destructive tool calls are flagged ⚠️ and delivered without waiting for turn end") by
// locking down every named pattern from PLAN.md § Destructive-action flagging, plus the two
// special cases (unguarded DELETE FROM, and Write/Edit targeting a credential-shaped path).
//
// isDestructiveToolCall is an attention aid only (a missed pattern loses the flag, not the
// event), so these tests assert the boolean flag, not any delivery behaviour — throughput/
// delivery-ordering for destructive blocks is covered in tests/monitor.test.ts.

import { describe, it, expect } from 'vitest';
import { isDestructiveToolCall } from '../src/monitor-destructive.js';

describe('isDestructiveToolCall — every named pattern', () => {
  const destructive: Array<[string, string]> = [
    ['rm -rf', 'rm -rf /tmp/foo'],
    ['rm -r (no f)', 'rm -r /tmp/foo'],
    ['rm --recursive', 'rm --recursive /tmp/foo'],
    ['git push --force', 'git push --force origin main'],
    ['git push -f', 'git push -f origin main'],
    ['git push --force-with-lease', 'git push --force-with-lease origin main'],
    ['git reset --hard', 'git reset --hard HEAD~3'],
    ['git clean -fd', 'git clean -fd'],
    ['git clean -df (flag order swapped)', 'git clean -df'],
    ['git branch -D', 'git branch -D old-feature'],
    ['DROP TABLE', 'DROP TABLE users;'],
    ['DROP DATABASE', 'DROP DATABASE prod;'],
    ['DROP SCHEMA', 'DROP SCHEMA public CASCADE;'],
    ['TRUNCATE', 'TRUNCATE TABLE logs;'],
    ['DELETE FROM without WHERE', 'DELETE FROM users;'],
    ['docker rm', 'docker rm -f mycontainer'],
    ['docker rmi', 'docker rmi myimage'],
    ['docker system prune', 'docker system prune -a'],
    ['docker volume rm', 'docker volume rm myvol'],
    ['systemctl stop', 'systemctl stop tgcc'],
    ['systemctl disable', 'systemctl disable tgcc'],
    ['kill -9', 'kill -9 1234'],
    ['chmod -R 777', 'chmod -R 777 /var/www'],
    ['mkfs', 'mkfs.ext4 /dev/sdb1'],
    ['dd of=', 'dd if=/dev/zero of=/dev/sda'],
    ['aws s3 rm', 'aws s3 rm s3://bucket/key'],
    ['aws s3 rb', 'aws s3 rb s3://bucket'],
    ['supabase db reset', 'supabase db reset'],
  ];

  for (const [label, command] of destructive) {
    it(`flags: ${label}`, () => {
      expect(isDestructiveToolCall('Bash', { command })).toBe(true);
    });
  }

  const nonDestructive: Array<[string, string]> = [
    ['plain rm -f (no recursive flag)', 'rm -f /tmp/foo'],
    ['plain git push', 'git push origin main'],
    ['guarded DELETE FROM ... WHERE', "DELETE FROM users WHERE id = 1;"],
    ['harmless ls', 'ls -la'],
    ['harmless git status', 'git status'],
    ['harmless docker ps', 'docker ps -a'],
  ];

  for (const [label, command] of nonDestructive) {
    it(`does not flag: ${label}`, () => {
      expect(isDestructiveToolCall('Bash', { command })).toBe(false);
    });
  }

  it('matches a destructive pattern nested inside a non-"command" field too (flattens the whole input)', () => {
    // e.g. a hypothetical tool whose relevant field isn't named "command"
    expect(isDestructiveToolCall('RunScript', { script: 'echo hi && rm -rf /data' })).toBe(true);
  });

  describe('credential-file edit special case', () => {
    it('flags Write to .env', () => {
      expect(isDestructiveToolCall('Write', { file_path: '/home/user/.env', content: 'X=1' })).toBe(true);
    });

    it('flags Write to a dotted .env variant (.env.production)', () => {
      expect(isDestructiveToolCall('Write', { file_path: '/home/user/.env.production', content: 'X=1' })).toBe(true);
    });

    it('flags Edit to credentials.json', () => {
      expect(isDestructiveToolCall('Edit', { file_path: '/home/user/credentials.json', old_string: 'a', new_string: 'b' })).toBe(true);
    });

    it('flags Edit to an id_rsa private key file', () => {
      expect(isDestructiveToolCall('Edit', { file_path: '/home/user/.ssh/id_rsa', old_string: 'a', new_string: 'b' })).toBe(true);
    });

    it('flags Write to secrets.yaml', () => {
      expect(isDestructiveToolCall('Write', { file_path: '/home/user/secrets.yaml', content: 'x' })).toBe(true);
    });

    it('does not flag Write to an ordinary file', () => {
      expect(isDestructiveToolCall('Write', { file_path: '/home/user/notes.txt', content: 'x' })).toBe(false);
    });

    it('does not flag Read of a credential file (only Write/Edit/MultiEdit/NotebookEdit count)', () => {
      expect(isDestructiveToolCall('Read', { file_path: '/home/user/.env' })).toBe(false);
    });
  });

  it('never throws on malformed/unexpected input shapes', () => {
    expect(() => isDestructiveToolCall('Bash', null)).not.toThrow();
    expect(() => isDestructiveToolCall('Bash', undefined)).not.toThrow();
    expect(() => isDestructiveToolCall('Bash', 'not-an-object')).not.toThrow();
    expect(isDestructiveToolCall('Bash', null)).toBe(false);
  });
});
