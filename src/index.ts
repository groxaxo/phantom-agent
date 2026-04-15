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
    task:             { type: 'string',  short: 't' },
    headless:         { type: 'boolean', short: 'H' },
    headed:           { type: 'boolean' },
    model:            { type: 'string',  short: 'm' },
    'observer-model': { type: 'string' },
    'no-observer':    { type: 'boolean' },
    'base-url':       { type: 'string' },
    'api-key':        { type: 'string' },
    'ws-endpoint':    { type: 'string', short: 'w' },
    'use-real-chrome':    { type: 'boolean', short: 'r' },
    'user-data-dir':      { type: 'string' },
    'profile-directory':  { type: 'string' },
    'max-steps':      { type: 'string' },
    'step-delay':     { type: 'string' },
    vision:           { type: 'boolean', default: false },
    debug:            { type: 'boolean', short: 'd', default: false },
    help:             { type: 'boolean', short: 'h', default: false },
    version:          { type: 'boolean', short: 'v', default: false },
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
    -t, --task <string>           Task description (required)
    -H, --headless                Run Chrome in headless mode
        --headed                  Force Chrome UI mode
    -m, --model <string>          Actor LLM model name (default: glm-5.1)
        --observer-model <string>  Observer model for DOM summarization (default: glm-5-turbo)
        --no-observer              Disable the observer model (single-model mode)
        --base-url <string>       LLM API base URL
        --api-key <string>        LLM API key
    -w, --ws-endpoint <url>       Connect to existing Chrome DevTools WebSocket
    -r, --use-real-chrome         Connect to user's real Chrome session (avoids bot detection)
        --user-data-dir <dir>     Chrome user data dir (default: detected signed-in profile)
        --profile-directory       Chrome profile directory (e.g. Default, Profile 1)
        --max-steps <n>           Maximum agent steps (default: 40)
        --step-delay <ms>         Delay between steps in ms (default: 400)
        --vision                  Enable screenshot-based perception
    -d, --debug                   Enable debug logging
    -h, --help                    Show this help
    -v, --version                 Show version
  `);
  process.exit(args.help ? 0 : 1);
}

// ─── Env overrides from CLI args ───────────────────────────────
if (args.headless && args.headed) {
  console.error('Choose either --headless or --headed, not both.');
  process.exit(1);
}

if (typeof args.model === 'string') process.env.LLM_MODEL = args.model;
if (typeof args['observer-model'] === 'string') process.env.OBSERVER_MODEL = args['observer-model'];
if (args['no-observer']) process.env.OBSERVER_MODEL = '';
if (typeof args['base-url'] === 'string') process.env.LLM_BASE_URL = args['base-url'];
if (typeof args['api-key'] === 'string') process.env.LLM_API_KEY = args['api-key'];
if (typeof args['ws-endpoint'] === 'string') process.env.CHROME_WS_ENDPOINT = args['ws-endpoint'];
if (args['use-real-chrome']) process.env.USE_REAL_CHROME = 'true';
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

  console.log(`
  ╔══════════════════════════════════════════════════════════════╗
  ║                                                              ║
  ║    ██████╗ ██╗  ██╗ █████╗ ███╗   ██╗████████╗ █████╗      ║
  ║    ██╔══██╗██║  ██║██╔══██╗████╗  ██║╚══██╔══╝██╔══██╗     ║
  ║    ██████╔╝███████║███████║██╔██╗ ██║   ██║   ███████║     ║
  ║    ██╔═══╝ ██╔══██║██╔══██║██║╚██╗██║   ██║   ██╔══██║     ║
  ║    ██║     ██║  ██║██║  ██║██║ ╚████║   ██║   ██║  ██║     ║
  ║    ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝     ║
  ║                                                              ║
  ║              A U T O N O M O U S   A G E N T                ║
  ║                                                              ║
  ╚══════════════════════════════════════════════════════════════╝
  `);

  logger.info('Main', `📋 Task: ${task}`);
  logger.info('Main', `🤖 Actor model: ${config.llm.model}`);
  if (config.observerLlm) {
    logger.info('Main', `🔭 Observer model: ${config.observerLlm.model} (DOM summarizer active)`);
  } else {
    logger.info('Main', `🔭 Observer: disabled (single-model mode)`);
  }
    logger.info('Main', `🔗 LLM endpoint: ${config.llm.baseURL}`);
    logger.info('Main', `🪟 Browser mode: ${config.browser.useRealChrome ? 'real-chrome' : config.browser.headless ? 'headless' : 'headed'}`);

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

    // Collect token usage from history
    let tp = 0, tc = 0, tt = 0;  // actor totals
    let op = 0, oc = 0, ot = 0;  // observer totals
    for (const e of result.history) {
      if (e.type === 'step') {
        if (e.usage) {
          tp += e.usage.promptTokens;
          tc += e.usage.completionTokens;
          tt += e.usage.totalTokens;
        }
        if (e.observerUsage) {
          op += e.observerUsage.promptTokens;
          oc += e.observerUsage.completionTokens;
          ot += e.observerUsage.totalTokens;
        }
      }
    }

    const fmt = (n: number) => n.toLocaleString();
    if (tt > 0 || ot > 0) {
      if (ot > 0) {
        logger.info('Main', `💰 Actor tokens:    ${fmt(tp)} prompt / ${fmt(tc)} completion / ${fmt(tt)} total`);
        logger.info('Main', `🔭 Observer tokens: ${fmt(op)} prompt / ${fmt(oc)} completion / ${fmt(ot)} total`);
        logger.info('Main', `📊 Combined:        ${fmt(tp + op)} prompt / ${fmt(tc + oc)} completion / ${fmt(tt + ot)} total`);
      } else {
        logger.info('Main', `💰 Token usage: ${fmt(tp)} prompt / ${fmt(tc)} completion / ${fmt(tt)} total`);
      }
    }

    process.exit(result.success ? 0 : 1);

  } catch (error) {
    logger.error('Main', `Fatal error: ${(error as Error).message}`);
    if (args.debug) console.error(error);
    process.exit(2);
  }
}

main();
