#!/usr/bin/env node
/**
 * phantom-agent — Autonomous AI-driven Chrome browser agent.
 * CLI entry point: parses args, launches browser, runs agent loop.
 */
import { parseArgs } from 'node:util';
import { buildConfig } from './config.js';
import { logger, setLogLevel } from './utils/logger.js';
import { startTaskRun } from './runtime/task-runner.js';

const { values: args } = parseArgs({
  options: {
    task:          { type: 'string',  short: 't' },
    headless:      { type: 'boolean', short: 'H' },
    headed:        { type: 'boolean' },
    model:         { type: 'string',  short: 'm' },
    'base-url':    { type: 'string' },
    'api-key':     { type: 'string' },
    'ws-endpoint': { type: 'string', short: 'w' },
    'user-data-dir': { type: 'string' },
    'profile-directory': { type: 'string' },
    'max-steps':   { type: 'string' },
    'step-delay':  { type: 'string' },
    vision:        { type: 'boolean', default: false },
    debug:         { type: 'boolean', short: 'd', default: false },
    help:          { type: 'boolean', short: 'h', default: false },
    version:       { type: 'boolean', short: 'v', default: false },
  },
  strict: false,
  allowPositionals: true,
});

if (args.version) {
  console.log('phantom-agent 1.0.0');
  process.exit(0);
}

if (args.help || !args.task) {
  console.log(`
  phantom-agent — Autonomous AI browser agent

  Usage:
    phantom-agent --task "Search for latest AI news" [options]

  Options:
    -t, --task <string>       Task description (required)
    -H, --headless            Run Chrome in headless mode
        --headed              Force Chrome UI mode
    -m, --model <string>      LLM model name (default: from env)
        --base-url <string>   LLM API base URL (default: http://localhost:8000/v1)
        --api-key <string>    LLM API key
    -w, --ws-endpoint <url>   Connect to existing Chrome DevTools WebSocket
        --user-data-dir <dir> Chrome user data dir (default: detected signed-in profile)
        --profile-directory   Chrome profile directory (e.g. Default, Profile 1)
        --max-steps <n>       Maximum agent steps (default: 40)
        --step-delay <ms>     Delay between steps in ms (default: 400)
        --vision              Enable screenshot-based perception
    -d, --debug               Enable debug logging
    -h, --help                Show this help
    -v, --version             Show version
  `);
  process.exit(args.help ? 0 : 1);
}

// ─── Env overrides from CLI args ───────────────────────────────
if (args.headless && args.headed) {
  console.error('Choose either --headless or --headed, not both.');
  process.exit(1);
}

if (typeof args.model === 'string') process.env.LLM_MODEL = args.model;
if (typeof args['base-url'] === 'string') process.env.LLM_BASE_URL = args['base-url'];
if (typeof args['api-key'] === 'string') process.env.LLM_API_KEY = args['api-key'];
if (typeof args['ws-endpoint'] === 'string') process.env.CHROME_WS_ENDPOINT = args['ws-endpoint'];
if (typeof args['user-data-dir'] === 'string') process.env.USER_DATA_DIR = args['user-data-dir'];
if (typeof args['profile-directory'] === 'string') process.env.PROFILE_DIRECTORY = args['profile-directory'];
if (typeof args['max-steps'] === 'string') process.env.MAX_STEPS = args['max-steps'];
if (typeof args['step-delay'] === 'string') process.env.STEP_DELAY_MS = args['step-delay'];
if (args.headless) process.env.HEADLESS = 'true';
if (args.headed) process.env.HEADLESS = 'false';
if (args.debug) process.env.LOG_LEVEL = 'debug';
if (args.debug) setLogLevel('debug');

// ─── Main ──────────────────────────────────────────────────────
async function main(): Promise<void> {
  const config = buildConfig();
  const task = args.task!;

  logger.info('Main', '🚀 phantom-agent starting');
  logger.info('Main', `📋 Task: ${task}`);
  logger.info('Main', `🤖 Model: ${config.llm.model}`);
  logger.info('Main', `🔗 LLM endpoint: ${config.llm.baseURL}`);
    logger.info('Main', `🪟 Browser mode: ${config.browser.headless ? 'headless' : 'headed'}`);

  try {
    const run = await startTaskRun({
      task: String(task),
      configOverrides: {
        enableVision: !!args.vision,
      },
    });

    // Handle SIGINT gracefully
    const onSigint = () => {
      logger.warn('Main', '⛔ Received SIGINT, stopping agent...');
      run.stop();
    };
    process.on('SIGINT', onSigint);

    // Execute
    logger.info('Main', '━━━ Agent loop starting ━━━');
    const result = await run.completed;

    process.removeListener('SIGINT', onSigint);

    // Output result
    if (result.success) {
      logger.info('Main', `\n✅ Task completed successfully`);
      logger.info('Main', `📝 ${result.data}`);
    } else {
      logger.error('Main', `\n❌ Task failed`);
      logger.error('Main', `📝 ${result.data}`);
    }

    const steps = result.history.filter(e => e.type === 'step').length;
    logger.info('Main', `📊 Total steps: ${steps}`);

    process.exit(result.success ? 0 : 1);

  } catch (error) {
    logger.error('Main', `Fatal error: ${(error as Error).message}`);
    if (args.debug) console.error(error);
    process.exit(2);
  }
}

main();
