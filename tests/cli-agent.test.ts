import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

// Test the agent management commands by running the CLI binary directly.
// We use a temp config file and override CONFIG_PATH via env.

const testDir = join(tmpdir(), `tgcc-cli-agent-${Date.now()}`);
const configPath = join(testDir, 'config.json');
const cliPath = join(__dirname, '..', 'dist', 'cli.js');

function runCli(args: string): string {
  try {
    return execSync(`node ${cliPath} ${args}`, {
      env: { ...process.env, TGCC_CONFIG: configPath, HOME: testDir },
      cwd: testDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch (err: any) {
    return (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '');
  }
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

describe('tgcc agent commands', () => {
  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(join(testDir, '.tgcc'), { recursive: true });
    // Write minimal config
    writeFileSync(
      join(testDir, '.tgcc', 'config.json'),
      JSON.stringify({ agents: {} }, null, 2),
    );
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it('adds an agent with --bot-token', () => {
    const output = runCli('agent add myagent --bot-token test-token-123');
    expect(output).toContain('added');

    const config = JSON.parse(
      readFileSync(join(testDir, '.tgcc', 'config.json'), 'utf-8'),
    );
    expect(config.agents.myagent).toBeDefined();
    expect(config.agents.myagent.botToken).toBe('test-token-123');
  });

  it('adds an agent with --repo', () => {
    const output = runCli('agent add myagent --bot-token tok --repo /tmp');
    expect(output).toContain('added');
    expect(output).toContain('repo');

    const config = JSON.parse(
      readFileSync(join(testDir, '.tgcc', 'config.json'), 'utf-8'),
    );
    expect(config.agents.myagent.defaults.repo).toBeDefined();
  });

  it('removes an agent', () => {
    // First add
    runCli('agent add delme --bot-token tok');
    // Then remove
    const output = runCli('agent remove delme');
    expect(output).toContain('removed');

    const config = JSON.parse(
      readFileSync(join(testDir, '.tgcc', 'config.json'), 'utf-8'),
    );
    expect(config.agents.delme).toBeUndefined();
  });

  it('lists agents', () => {
    runCli('agent add first --bot-token tok1');
    runCli('agent add second --bot-token tok2');

    const output = runCli('agent list');
    expect(output).toContain('first');
    expect(output).toContain('second');
  });

  it('rejects duplicate agent names', () => {
    runCli('agent add dup --bot-token tok');
    const output = runCli('agent add dup --bot-token tok2');
    expect(output).toContain('already exists');
  });

  it('errors when removing non-existent agent', () => {
    const output = runCli('agent remove ghost');
    expect(output).toContain('not found');
  });

  it('errors when adding without --bot-token', () => {
    const output = runCli('agent add notoken');
    expect(output).toContain('--bot-token');
  });
});
