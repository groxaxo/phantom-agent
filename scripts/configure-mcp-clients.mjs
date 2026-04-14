#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const home = homedir();
const projectRoot = new URL('..', import.meta.url).pathname;
const serverCommand = 'node';
const serverArgs = [join(projectRoot, 'dist', 'phantom-agent-mcp.mjs')];

async function detectOpenAiCompatibleLlm() {
  if (process.env.LLM_BASE_URL && process.env.LLM_MODEL) {
    return {
      baseUrl: process.env.LLM_BASE_URL,
      model: process.env.LLM_MODEL,
      apiKey: process.env.LLM_API_KEY ?? '',
    };
  }

  const candidates = [
    'http://127.0.0.1:11434/v1',
    'http://localhost:11434/v1',
    'http://127.0.0.1:8000/v1',
    'http://localhost:8000/v1',
  ];

  for (const baseUrl of candidates) {
    try {
      const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) continue;
      const payload = await response.json();
      const model = Array.isArray(payload?.data) ? payload.data[0]?.id : undefined;
      if (typeof model === 'string' && model.length > 0) {
        return {
          baseUrl,
          model,
          apiKey: '',
        };
      }
    } catch {}
  }

  return {
    baseUrl: process.env.LLM_BASE_URL ?? 'http://localhost:8000/v1',
    model: process.env.LLM_MODEL ?? 'meta-llama/Llama-3.1-8B-Instruct',
    apiKey: process.env.LLM_API_KEY ?? '',
  };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} failed (${code})\n${stdout}\n${stderr}`));
    });
  });
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const llm = await detectOpenAiCompatibleLlm();
const defaultEnv = {
  LLM_BASE_URL: llm.baseUrl,
  LLM_MODEL: llm.model,
  LLM_API_KEY: llm.apiKey,
  HEADLESS: process.env.HEADLESS ?? 'false',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'error',
};

async function configureOpencode() {
  const configPath = join(home, '.config', 'opencode', 'opencode.json');
  const config = await readJson(configPath, {});
  const mcp = typeof config.mcp === 'object' && config.mcp !== null ? config.mcp : {};

  mcp['phantom-agent'] = {
    type: 'local',
    command: [serverCommand, ...serverArgs],
    environment: defaultEnv,
    enabled: true,
  };

  config.$schema = config.$schema ?? 'https://opencode.ai/config.json';
  config.mcp = mcp;
  await writeJson(configPath, config);
}

async function configureGemini() {
  try {
    await run('gemini', ['mcp', 'remove', 'phantom-agent']);
  } catch {}

  const args = ['mcp', 'add', '--scope', 'user'];
  for (const [key, value] of Object.entries(defaultEnv)) {
    args.push('--env', `${key}=${value}`);
  }
  args.push('phantom-agent', serverCommand, ...serverArgs);
  await run('gemini', args);
}

async function configureCopilot() {
  try {
    await run('copilot', ['mcp', 'remove', 'phantom-agent']);
  } catch {}

  const args = ['mcp', 'add'];
  for (const [key, value] of Object.entries(defaultEnv)) {
    args.push('--env', `${key}=${value}`);
  }
  args.push('phantom-agent', '--', serverCommand, ...serverArgs);
  await run('copilot', args);
}

await configureOpencode();
await configureGemini();
await configureCopilot();

console.log('Configured phantom-agent MCP for OpenCode, Gemini CLI, and Copilot CLI.');
