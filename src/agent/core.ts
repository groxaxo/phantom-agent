/**
 * Core ReAct agent loop.
 * Synthesized from page-agent's PageAgentCore — implements the
 * Observe → Think → Act → Reflect cycle with reflection-before-action.
 */
import type {
  AgentConfig,
  AgentStatus,
  BrowserState,
  ExecutionResult,
  HistoricalEvent,
  MacroToolResult,
  ToolContext,
  ToolDefinition,
  TokenUsage,
} from '../types.js';
import { PageController } from '../actions/page-controller.js';
import { createToolRegistry } from '../actions/tools.js';
import { LLMClient, InvokeError } from './llm-client.js';
import { ObserverClient } from './observer.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';
import { logger } from '../utils/logger.js';
import { uid, waitFor } from '../utils/helpers.js';

export class AgentCore {
  readonly id = uid();
  readonly config: AgentConfig;
  readonly tools: Map<string, ToolDefinition>;
  readonly pageController: PageController;

  task = '';
  taskId = '';
  history: HistoricalEvent[] = [];

  private status: AgentStatus = 'idle';
  private llm: LLMClient;
  private observer?: ObserverClient;
  private abortController = new AbortController();
  private observations: string[] = [];

  private states = {
    totalWaitTime: 0,
    lastURL: '',
    browserState: null as BrowserState | null,
    tokens: { prompt: 0, completion: 0, total: 0 },
    observerTokens: { prompt: 0, completion: 0, total: 0 },
  };

  constructor(config: AgentConfig, pageController: PageController) {
    this.config = config;
    this.pageController = pageController;
    this.llm = new LLMClient(config.llm);
    if (config.observerLlm) {
      this.observer = new ObserverClient(config.observerLlm);
    }
    this.tools = createToolRegistry();
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  /** Push an observation that will be included in the next LLM context */
  pushObservation(content: string): void {
    this.observations.push(content);
  }

  /** Stop the current task */
  stop(): void {
    this.abortController.abort();
  }

  /**
   * Execute an autonomous task — the main ReAct loop.
   *
   * Loop:
   *   1. OBSERVE: Extract DOM state, detect changes
   *   2. [SUMMARIZE]: Optional observer model compresses DOM to compact summary
   *   3. THINK: Call actor LLM with context (full DOM or observer summary)
   *   4. ACT: Execute the selected tool
   *   5. Record history, loop
   */
  async execute(task: string): Promise<ExecutionResult> {
    if (!task) throw new Error('Task is required');

    this.task = task;
    this.taskId = uid();
    this.history = [];
    this.observations = [];
    this.states = {
      totalWaitTime: 0,
      lastURL: '',
      browserState: null,
      tokens: { prompt: 0, completion: 0, total: 0 },
      observerTokens: { prompt: 0, completion: 0, total: 0 },
    };
    this.status = 'running';
    this.abortController = new AbortController();

    const fmt = (n: number) => n.toLocaleString();
    let step = 0;

    while (true) {
      try {
        logger.info('Agent', `━━━ Step ${step} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        // ── OBSERVE ───────────────────────────────────────────
        logger.info('Agent', '👀 Observing...');
        this.states.browserState = await this.pageController.getBrowserState();
        await this.handleObservations(step);

        // ── SUMMARIZE (observer model, optional) ──────────────
        let observerSummary: string | undefined;
        let observerUsage: TokenUsage | undefined;

        if (this.observer && this.states.browserState) {
          logger.info('Agent', '🔭 Summarizing...');
          const obs = await this.observer.summarize(this.states.browserState);
          observerSummary = obs.summary;
          observerUsage = obs.usage;

          this.states.observerTokens.prompt += obs.usage.promptTokens;
          this.states.observerTokens.completion += obs.usage.completionTokens;
          this.states.observerTokens.total += obs.usage.totalTokens;

          const cached = obs.usage.cachedTokens ? ` (${fmt(obs.usage.cachedTokens)} cached)` : '';
          logger.info(
            'Agent',
            `🔭 Observer: +${fmt(obs.usage.promptTokens)} prompt / +${fmt(obs.usage.completionTokens)} completion${cached} → running observer total: ${fmt(this.states.observerTokens.total)}`,
          );
        }

        // ── THINK ─────────────────────────────────────────────
        logger.info('Agent', '🧠 Thinking...');

        const systemPrompt = this.config.customSystemPrompt ?? SYSTEM_PROMPT;
        const stepCount = this.history.filter(e => e.type === 'step').length;

        const userPrompt = buildUserPrompt({
          task: this.task,
          stepCount,
          maxSteps: this.config.maxSteps,
          history: this.history as any,
          browserState: this.states.browserState!,
          instructions: this.config.instructions?.system,
          observerSummary,
        });

        const messages = [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content: userPrompt },
        ];

        // Build tool context for execution
        const toolCtx: ToolContext = {
          pageController: this.pageController,
        };

        // LLM invocation — returns reflection + executed action
        const result = await this.llm.invoke(
          messages,
          this.tools,
          async (name: string, input: unknown) => {
            const tool = this.tools.get(name);
            if (!tool) throw new Error(`Tool "${name}" not found`);

            logger.info('Agent', `⚡ Executing: ${name}`, JSON.stringify(input).slice(0, 200));
            const output = await tool.execute(input, toolCtx);
            logger.info('Agent', `✓ Result: ${output.slice(0, 200)}`);
            return output;
          },
          this.abortController.signal,
        );

        // ── RECORD ────────────────────────────────────────────
        const macroResult = result.toolResult as MacroToolResult;
        const actionName = result.toolCall.name;

        const reflection = {
          evaluation_previous_goal: macroResult.input.evaluation_previous_goal,
          memory: macroResult.input.memory,
          next_goal: macroResult.input.next_goal,
        };

        // Log reflection
        if (reflection.evaluation_previous_goal) {
          logger.info('Agent', `✅ Eval: ${reflection.evaluation_previous_goal}`);
        }
        if (reflection.memory) {
          logger.info('Agent', `💾 Memory: ${reflection.memory}`);
        }
        if (reflection.next_goal) {
          logger.info('Agent', `🎯 Goal: ${reflection.next_goal}`);
        }

        this.history.push({
          type: 'step',
          stepIndex: step,
          reflection,
          action: {
            name: actionName,
            input: result.toolCall.args,
            output: macroResult.output,
          },
          usage: result.usage,
          observerUsage,
        });

        // ── TOKEN TRACKING ────────────────────────────────────
        if (result.usage) {
          const u = result.usage;
          this.states.tokens.prompt += u.promptTokens ?? 0;
          this.states.tokens.completion += u.completionTokens ?? 0;
          this.states.tokens.total += u.totalTokens ?? 0;
          const cached = u.cachedTokens ? ` (${fmt(u.cachedTokens)} cached)` : '';

          if (this.observer) {
            logger.info(
              'Agent',
              `📊 Actor: +${fmt(u.promptTokens ?? 0)} prompt / +${fmt(u.completionTokens ?? 0)} completion${cached} → running actor total: ${fmt(this.states.tokens.total)}`,
            );
            const combined = this.states.tokens.total + this.states.observerTokens.total;
            logger.info('Agent', `📊 Combined total so far: ${fmt(combined)}`);
          } else {
            logger.info(
              'Agent',
              `📊 Tokens: +${fmt(u.promptTokens ?? 0)} prompt / +${fmt(u.completionTokens ?? 0)} completion${cached} → total: ${fmt(this.states.tokens.prompt)} / ${fmt(this.states.tokens.completion)} / ${fmt(this.states.tokens.total)}`,
            );
          }
        }

        // ── CHECK DONE ────────────────────────────────────────
        if (actionName === 'done') {
          const input = result.toolCall.args as any;
          const success = input?.success ?? false;
          const text = input?.text ?? 'No response provided';

          logger.info('Agent', `🏁 Task ${success ? 'COMPLETED' : 'FAILED'}: ${text.slice(0, 200)}`);
          this.status = success ? 'completed' : 'error';

          return { success, data: text, history: this.history };
        }

        // Track wait time
        if (actionName === 'wait') {
          this.states.totalWaitTime += (result.toolCall.args as any)?.seconds ?? 0;
        } else {
          this.states.totalWaitTime = 0;
        }

      } catch (error: unknown) {
        const isAbort = (error as any)?.name === 'AbortError' ||
          (error instanceof InvokeError && error.message.includes('Abort'));

        const msg = isAbort ? 'Task stopped by user' : String(error);
        logger.error('Agent', `Step ${step} error: ${msg}`);

        this.history.push({ type: 'error', message: msg });
        this.status = 'error';

        return { success: false, data: msg, history: this.history };
      }

      // Step increment + limit check
      step++;
      if (step > this.config.maxSteps) {
        const msg = `Step limit exceeded (${this.config.maxSteps})`;
        logger.warn('Agent', msg);
        this.history.push({ type: 'error', message: msg });
        this.status = 'error';
        return { success: false, data: msg, history: this.history };
      }

      // Inter-step delay
      await waitFor(this.config.stepDelayMs / 1000);
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────

  private async handleObservations(step: number): Promise<void> {
    // Accumulated wait time warning
    if (this.states.totalWaitTime >= 3) {
      this.pushObservation(
        `You have waited ${this.states.totalWaitTime} seconds total. Do NOT wait more unless necessary.`,
      );
    }

    // URL change detection
    const currentURL = this.states.browserState?.url ?? '';
    if (currentURL && currentURL !== this.states.lastURL) {
      if (this.states.lastURL) {
        this.pushObservation(`Page navigated to → ${currentURL}`);
      }
      this.states.lastURL = currentURL;
      await waitFor(0.3);
    }

    // Remaining steps warnings
    const remaining = this.config.maxSteps - step;
    if (remaining === 5) {
      this.pushObservation(`⚠️ Only ${remaining} steps remaining. Consider wrapping up.`);
    } else if (remaining === 2) {
      this.pushObservation(`⚠️ Critical: Only ${remaining} steps left! Finish or call done.`);
    }

    // Flush observations to history
    for (const content of this.observations) {
      this.history.push({ type: 'observation', content });
      logger.info('Agent', `📋 Observation: ${content}`);
    }
    this.observations = [];
  }
}

