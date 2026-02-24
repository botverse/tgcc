import pino from 'pino';
import { loadConfig, ensureDirectories, ConfigWatcher, CONFIG_PATH } from './config.js';
import { Bridge } from './bridge.js';

async function main(): Promise<void> {
  // ── Load config ──
  const configPath = process.env.TGCC_CONFIG ?? CONFIG_PATH;
  let config;

  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error(`Failed to load config from ${configPath}:`);
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // ── Setup logger ──
  const logger = pino({
    level: config.global.logLevel,
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
  });

  // ── Ensure directories ──
  ensureDirectories(config);

  // ── Startup self-test ──
  logger.info({ configPath, agents: Object.keys(config.agents) }, 'TGCC starting');

  // ── Create bridge ──
  const bridge = new Bridge(config, logger);

  // ── Config watcher (hot reload) ──
  const watcher = new ConfigWatcher(config, configPath, logger);

  watcher.on('change', async (newConfig, diff) => {
    try {
      await bridge.handleConfigChange(newConfig, diff);
    } catch (err) {
      logger.error({ err }, 'Failed to apply config change');
    }
  });

  watcher.on('error', (err) => {
    logger.error({ err }, 'Config watcher error');
  });

  // ── SIGHUP → manual reload ──
  process.on('SIGHUP', () => {
    logger.info('SIGHUP received — reloading config');
    watcher.reload();
  });

  // ── Graceful shutdown ──
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutdown signal received');

    // Stop watching config
    watcher.stop();

    // Stop bridge (stops all bots, kills all CC processes, closes MCP sockets)
    try {
      await bridge.stop();
    } catch (err) {
      logger.error({ err }, 'Error during bridge shutdown');
    }

    logger.info('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Uncaught exceptions — log and continue (don't crash on TG errors)
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled rejection');
  });

  // ── Start ──
  await bridge.start();
  watcher.start();

  logger.info('TGCC is running');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
