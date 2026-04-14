# phantom-agent

Autonomous AI-driven Chrome browser automation with MCP support, local-profile reuse, and a direct CDP control layer.

[![CI](https://github.com/groxaxo/phantom-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/groxaxo/phantom-agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What it does

- Launches Chrome with your signed-in profile by default
- Supports headless and headed modes
- Runs autonomous browser tasks through an OpenAI-compatible LLM
- Exposes a stdio MCP server for Copilot CLI, Gemini CLI, and OpenCode
- Provides direct browser-session tools for external agents that want to reason over pages themselves

## Requirements

- Node.js 20+
- Google Chrome, Chromium, or Microsoft Edge
- An OpenAI-compatible LLM endpoint for autonomous task mode

## Quick start

```bash
npm install
npm run build
npm start -- --task "Open example.com and tell me the page title"
```

## Browser mode

By default, phantom-agent will try to reuse your local Chrome or Chromium profile so sites see your normal signed-in state.

```bash
# Headed
npm start -- --task "Check my inbox" --headed

# Headless
npm start -- --task "Summarize the homepage title" --headless

# Specific Chrome profile
npm start -- --task "Use profile 1" --profile-directory "Profile 1"
```

If you already run Chrome with that profile, close it first or attach with `--ws-endpoint`.

## LLM configuration

phantom-agent works with any OpenAI-compatible server:

```bash
export LLM_BASE_URL=http://127.0.0.1:11434/v1
export LLM_MODEL=hf.co/unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL
npm start -- --task "Open example.com and read the title"
```

## MCP server

Build and run the MCP server:

```bash
npm run build
npm run start:mcp
```

### Tools

| Tool | Purpose |
|------|---------|
| `execute_task` | Run an autonomous browser task end to end |
| `launch_browser_session` | Open a browser session for direct control |
| `get_browser_state` | Read the current page snapshot |
| `navigate` | Go to a URL |
| `click_element_by_index` | Click an indexed element |
| `input_text` | Type into an indexed input |
| `scroll` | Scroll the page or a container |
| `press_enter` | Send Enter |
| `execute_javascript` | Run JS in the page |
| `close_browser_session` | Close the current session |
| `get_status` | Inspect active and last run state |
| `stop_task` | Stop a running autonomous task |

## Configure local clients

Register the server in OpenCode, Gemini CLI, and Copilot CLI on this machine:

```bash
npm run configure:mcp-clients
```

That updates:

- `~/.config/opencode/opencode.json`
- `~/.gemini/antigravity/mcp_config.json`
- `~/.copilot/mcp-config.json`

## Docker

```bash
docker compose up -d vllm
docker compose run phantom-agent --task "Open example.com"
```

## Scripts

| Script | What it does |
|--------|--------------|
| `npm start` | Run the autonomous agent |
| `npm run start:mcp` | Run the MCP server |
| `npm run configure:mcp-clients` | Register local MCP clients |
| `npm run typecheck` | Type-check the codebase |
| `npm run build` | Build both runnable entrypoints |

## Project layout

```text
src/
├── agent/        ReAct loop and LLM client
├── actions/      Page interaction tools
├── browser/      CDP transport, launcher, stealth
├── mcp/          MCP server entrypoint
├── perception/   DOM and screenshot state
├── runtime/      Shared task and browser session runners
└── utils/        Logging and helpers
```

## Troubleshooting

- **MCP server disconnects**: rebuild the project and run `npm run start:mcp`
- **Autonomous task fails immediately**: point `LLM_BASE_URL` to a working OpenAI-compatible model server
- **Chrome profile is locked**: close existing Chrome windows or pass `--ws-endpoint`

## License

MIT
