import type { AgentConfig, StealthConfig, BrowserLaunchOptions, LLMConfig } from './types.js';

const DEFAULT_USER_AGENTS = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

function randomUA(): string {
  return DEFAULT_USER_AGENTS[Math.floor(Math.random() * DEFAULT_USER_AGENTS.length)];
}

function env(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

function envFloat(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseFloat(v) : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v === 'true' || v === '1';
}

function defined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export function buildConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const stealth: StealthConfig = {
    userAgent: env('USER_AGENT') || randomUA(),
    platform: 'Linux x86_64',
    vendor: 'Google Inc.',
    languages: [env('LOCALE', 'en-US'), 'en'],
    webglVendor: env('WEBGL_VENDOR', 'Intel Inc.'),
    webglRenderer: env('WEBGL_RENDERER', 'Intel Iris OpenGL Engine'),
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 0,
    timezone: env('TIMEZONE', 'America/New_York'),
    locale: env('LOCALE', 'en-US'),
    ...overrides.stealth,
  };

  const browser: BrowserLaunchOptions = {
    headless: envBool('HEADLESS', envBool('CHROME_HEADLESS', false)),
    executablePath: env('CHROME_PATH') || undefined,
    wsEndpoint: env('CHROME_WS_ENDPOINT') || undefined,
    userDataDir: env('USER_DATA_DIR') || undefined,
    profileDirectory: env('PROFILE_DIRECTORY') || undefined,
    viewport: {
      width: envInt('VIEWPORT_WIDTH', 1920),
      height: envInt('VIEWPORT_HEIGHT', 1080),
    },
    userAgent: stealth.userAgent,
    timezone: stealth.timezone,
    locale: stealth.locale,
    ...overrides.browser,
  };

  const llm: LLMConfig = {
    baseURL: env('LLM_BASE_URL', 'http://localhost:8000/v1'),
    model: env('LLM_MODEL', 'meta-llama/Llama-3.1-8B-Instruct'),
    apiKey: env('LLM_API_KEY', ''),
    temperature: envFloat('LLM_TEMPERATURE', 0.1),
    maxRetries: 3,
    ...overrides.llm,
  };

  const baseConfig: AgentConfig = {
    llm,
    browser,
    stealth,
    maxSteps: envInt('MAX_STEPS', 40),
    stepDelayMs: envInt('STEP_DELAY_MS', 400),
    enableVision: envBool('ENABLE_VISION', false),
    language: 'en-US',
  };

  return {
    ...baseConfig,
    llm,
    browser,
    stealth,
    maxSteps: defined(overrides.maxSteps) ? overrides.maxSteps : baseConfig.maxSteps,
    stepDelayMs: defined(overrides.stepDelayMs) ? overrides.stepDelayMs : baseConfig.stepDelayMs,
    enableVision: defined(overrides.enableVision) ? overrides.enableVision : baseConfig.enableVision,
    language: overrides.language ?? baseConfig.language,
    customSystemPrompt: overrides.customSystemPrompt ?? baseConfig.customSystemPrompt,
    instructions: overrides.instructions ?? baseConfig.instructions,
  };
}
