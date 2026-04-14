#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { startTaskRun, type TaskRunHandle } from '../runtime/task-runner.js';
import type { AgentConfig, ExecutionResult } from '../types.js';
import { logger, setLogDestination, setLogLevel } from '../utils/logger.js';
import { openBrowserSession, type BrowserSessionHandle } from '../runtime/browser-session.js';

interface LastRunSummary {
  task: string;
  startedAt: string;
  finishedAt: string;
  success: boolean;
  response: string;
  steps: number;
}

function withDefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

setLogDestination('stderr');
setLogLevel(process.env.LOG_LEVEL?.toLowerCase() === 'debug' ? 'debug' : 'info');

const server = new McpServer({
  name: 'phantom-agent',
  version: '1.0.0',
});

let activeRun:
  | {
      task: string;
      startedAt: string;
      handle: TaskRunHandle;
    }
  | undefined;
let browserSession:
  | {
      openedAt: string;
      session: BrowserSessionHandle;
    }
  | undefined;
let lastRun: LastRunSummary | undefined;

function buildTaskConfig(input: {
  headless?: boolean;
  vision?: boolean;
  max_steps?: number;
  step_delay_ms?: number;
  ws_endpoint?: string;
  user_data_dir?: string;
  profile_directory?: string;
  chrome_path?: string;
  model?: string;
  base_url?: string;
  api_key?: string;
}): Partial<AgentConfig> {
  const browserOverrides = withDefined({
    headless: input.headless,
    wsEndpoint: input.ws_endpoint,
    userDataDir: input.user_data_dir,
    profileDirectory: input.profile_directory,
    executablePath: input.chrome_path,
  });
  const llmOverrides = withDefined({
    model: input.model,
    baseURL: input.base_url,
    apiKey: input.api_key,
    temperature: Number(process.env.LLM_TEMPERATURE ?? '0.1'),
    maxRetries: 3,
  });

  return withDefined({
    enableVision: input.vision,
    maxSteps: input.max_steps,
    stepDelayMs: input.step_delay_ms,
    browser: Object.keys(browserOverrides).length > 0 ? browserOverrides : undefined,
    llm: llmOverrides,
  }) as Partial<AgentConfig>;
}

function summarizeResult(task: string, startedAt: string, result: ExecutionResult): LastRunSummary {
  const steps = result.history.filter((entry) => entry.type === 'step').length;
  return {
    task,
    startedAt,
    finishedAt: new Date().toISOString(),
    success: result.success,
    response: result.data,
    steps,
  };
}

function ok(text: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
  };
}

function error(text: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
    isError: true,
  };
}

function requireBrowserSession(): BrowserSessionHandle {
  if (!browserSession) {
    throw new Error('No browser session is active. Call launch_browser_session first.');
  }

  return browserSession.session;
}

server.registerTool(
  'execute_task',
  {
    description: 'Run an autonomous phantom-agent browser task and wait for the final result.',
    inputSchema: {
      task: z.string().min(1).describe('Natural-language browser task to execute.'),
      headless: z.boolean().optional().describe('Run Chrome headless for this task.'),
      vision: z.boolean().optional().describe('Capture screenshots for vision-enabled models.'),
      max_steps: z.number().int().positive().max(200).optional().describe('Override the max agent step count.'),
      step_delay_ms: z.number().int().min(0).max(10000).optional().describe('Override the delay between steps in milliseconds.'),
      ws_endpoint: z.string().url().optional().describe('Attach to an existing Chrome DevTools websocket endpoint.'),
      user_data_dir: z.string().optional().describe('Override the Chrome user data directory.'),
      profile_directory: z.string().optional().describe('Specific Chrome profile directory, for example Default or Profile 1.'),
      chrome_path: z.string().optional().describe('Override the Chrome or Chromium executable path.'),
      model: z.string().optional().describe('Override the LLM model name for this run.'),
      base_url: z.string().optional().describe('Override the OpenAI-compatible LLM base URL for this run.'),
      api_key: z.string().optional().describe('Override the LLM API key for this run.'),
    },
  },
  async (input) => {
    if (activeRun) {
      return error(`A task is already running: "${activeRun.task}". Call stop_task first or wait for completion.`);
    }

    const startedAt = new Date().toISOString();
    logger.info('MCP', `Starting task via MCP: ${input.task}`);

    try {
      const handle = await startTaskRun({
        task: input.task,
        configOverrides: buildTaskConfig(input),
      });

      activeRun = {
        task: input.task,
        startedAt,
        handle,
      };

      const result = await handle.completed;
      lastRun = summarizeResult(input.task, startedAt, result);
      return ok(JSON.stringify(lastRun, null, 2));
    } catch (caughtError) {
      const message = (caughtError as Error).message;
      lastRun = {
        task: input.task,
        startedAt,
        finishedAt: new Date().toISOString(),
        success: false,
        response: message,
        steps: 0,
      };
      return error(`Task failed: ${message}`);
    } finally {
      activeRun = undefined;
    }
  },
);

server.registerTool(
  'launch_browser_session',
  {
    description: 'Launch or connect to a browser session that the external MCP client can control directly.',
    inputSchema: {
      headless: z.boolean().optional().describe('Run Chrome headless for this session.'),
      vision: z.boolean().optional().describe('Include screenshots in browser state responses.'),
      ws_endpoint: z.string().url().optional().describe('Attach to an existing Chrome DevTools websocket endpoint.'),
      user_data_dir: z.string().optional().describe('Override the Chrome user data directory.'),
      profile_directory: z.string().optional().describe('Specific Chrome profile directory, for example Default or Profile 1.'),
      chrome_path: z.string().optional().describe('Override the Chrome or Chromium executable path.'),
    },
  },
  async (input) => {
    if (browserSession) {
      await browserSession.session.close();
      browserSession = undefined;
    }

    const session = await openBrowserSession(buildTaskConfig(input));
    browserSession = {
      openedAt: new Date().toISOString(),
      session,
    };

    return ok(JSON.stringify({
      openedAt: browserSession.openedAt,
      headless: session.config.browser.headless,
      profileDirectory: session.config.browser.profileDirectory ?? null,
      userDataDir: session.config.browser.userDataDir ?? null,
      url: (await session.pageController.getBrowserState()).url,
    }, null, 2));
  },
);

server.registerTool(
  'get_browser_state',
  {
    description: 'Return the current phantom-agent browser state for the active browser session.',
    inputSchema: {},
  },
  async () => {
    const session = requireBrowserSession();
    const state = await session.pageController.getBrowserState();
    return ok(JSON.stringify(state, null, 2));
  },
);

server.registerTool(
  'navigate',
  {
    description: 'Navigate the active browser session to a URL.',
    inputSchema: {
      url: z.string().url().describe('Destination URL.'),
    },
  },
  async ({ url }) => {
    const session = requireBrowserSession();
    const result = await session.pageController.navigate(url);
    return ok(result.message);
  },
);

server.registerTool(
  'click_element_by_index',
  {
    description: 'Click an indexed interactive element in the active browser session.',
    inputSchema: {
      index: z.number().int().nonnegative().describe('Element index from get_browser_state content.'),
    },
  },
  async ({ index }) => {
    const session = requireBrowserSession();
    const result = await session.pageController.clickElement(index);
    return ok(result.message);
  },
);

server.registerTool(
  'input_text',
  {
    description: 'Type text into an indexed input element in the active browser session.',
    inputSchema: {
      index: z.number().int().nonnegative().describe('Element index from get_browser_state content.'),
      text: z.string().describe('Text to type into the element.'),
    },
  },
  async ({ index, text }) => {
    const session = requireBrowserSession();
    const result = await session.pageController.inputText(index, text);
    return ok(result.message);
  },
);

server.registerTool(
  'scroll',
  {
    description: 'Scroll the page or a specific scrollable element in the active browser session.',
    inputSchema: {
      down: z.boolean().describe('Scroll direction.'),
      pixels: z.number().int().positive().optional().describe('Pixel distance to scroll.'),
      index: z.number().int().nonnegative().optional().describe('Optional container element index.'),
    },
  },
  async ({ down, pixels, index }) => {
    const session = requireBrowserSession();
    const result = await session.pageController.scroll({ down, pixels, index });
    return ok(result.message);
  },
);

server.registerTool(
  'press_enter',
  {
    description: 'Press Enter in the active browser session.',
    inputSchema: {},
  },
  async () => {
    const session = requireBrowserSession();
    const result = await session.pageController.pressEnter();
    return ok(result.message);
  },
);

server.registerTool(
  'execute_javascript',
  {
    description: 'Run JavaScript in the active browser session.',
    inputSchema: {
      script: z.string().describe('JavaScript to evaluate in the page context.'),
    },
  },
  async ({ script }) => {
    const session = requireBrowserSession();
    const result = await session.pageController.executeJavascript(script);
    return ok(result.message);
  },
);

server.registerTool(
  'close_browser_session',
  {
    description: 'Close the active browser session.',
    inputSchema: {},
  },
  async () => {
    if (!browserSession) {
      return ok('No browser session is active.');
    }

    await browserSession.session.close();
    browserSession = undefined;
    return ok('Closed browser session.');
  },
);

server.registerTool(
  'get_status',
  {
    description: 'Return the current phantom-agent MCP task status and the last completed run summary.',
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            busy: !!activeRun,
            activeTask: activeRun
              ? {
                  task: activeRun.task,
                  startedAt: activeRun.startedAt,
                }
              : null,
            browserSession: browserSession
              ? {
                  openedAt: browserSession.openedAt,
                  headless: browserSession.session.config.browser.headless,
                }
              : null,
            lastRun: lastRun ?? null,
          },
          null,
          2,
        ),
      },
    ],
  }),
);

server.registerTool(
  'stop_task',
  {
    description: 'Stop the currently running phantom-agent task, if any.',
    inputSchema: {},
  },
  async () => {
    if (!activeRun) {
      return ok('No task is currently running.');
    }

    activeRun.handle.stop();
    return ok(`Stop signal sent for "${activeRun.task}".`);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
logger.info('MCP', 'phantom-agent MCP server ready');
