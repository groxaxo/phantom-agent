/**
 * OpenAI-compatible LLM client with retry logic.
 * Synthesized from page-agent's LLM + OpenAIClient —
 * works with vLLM, llama.cpp, Ollama, OpenAI, and any compatible endpoint.
 */
import type { LLMConfig, Message, InvokeResult, ToolDefinition, MacroToolInput, MacroToolResult } from '../types.js';
import { logger } from '../utils/logger.js';

export enum InvokeErrorType {
  NETWORK_ERROR = 'NETWORK_ERROR',
  AUTH_ERROR = 'AUTH_ERROR',
  RATE_LIMIT = 'RATE_LIMIT',
  SERVER_ERROR = 'SERVER_ERROR',
  CONTEXT_LENGTH = 'CONTEXT_LENGTH',
  CONTENT_FILTER = 'CONTENT_FILTER',
  NO_TOOL_CALL = 'NO_TOOL_CALL',
  INVALID_TOOL_ARGS = 'INVALID_TOOL_ARGS',
  TOOL_EXECUTION_ERROR = 'TOOL_EXECUTION_ERROR',
  UNKNOWN = 'UNKNOWN',
}

export class InvokeError extends Error {
  type: InvokeErrorType;
  rawError?: unknown;
  rawResponse?: unknown;
  retryable: boolean;

  constructor(type: InvokeErrorType, message: string, rawError?: unknown, rawResponse?: unknown) {
    super(message);
    this.name = 'InvokeError';
    this.type = type;
    this.rawError = rawError;
    this.rawResponse = rawResponse;
    this.retryable = [
      InvokeErrorType.NETWORK_ERROR,
      InvokeErrorType.RATE_LIMIT,
      InvokeErrorType.SERVER_ERROR,
    ].includes(type);
  }
}

/** Convert our tool definitions to OpenAI function calling format */
function toolsToOpenAI(tools: Map<string, ToolDefinition>): Array<Record<string, unknown>> {
  return Array.from(tools.entries()).map(([name, tool]) => ({
    type: 'function',
    function: {
      name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * Build the "AgentOutput" macro tool that wraps all individual tools
 * into a single tool call with reflection-before-action structure.
 */
export function buildMacroToolSchema(tools: Map<string, ToolDefinition>): Record<string, unknown> {
  const actionOneOf = Array.from(tools.entries()).map(([name, tool]) => ({
    type: 'object',
    properties: {
      [name]: tool.parameters,
    },
    required: [name],
    description: tool.description,
    additionalProperties: false,
  }));

  return {
    type: 'object',
    properties: {
      evaluation_previous_goal: {
        type: 'string',
        description: 'One-sentence analysis of your last action. State success, failure, or uncertain.',
      },
      memory: {
        type: 'string',
        description: '1-3 sentences of memory to track progress across steps.',
      },
      next_goal: {
        type: 'string',
        description: 'The next immediate goal and action to achieve it.',
      },
      action: {
        oneOf: actionOneOf,
        description: 'The action to execute.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  };
}

function buildContentFallbackInstruction(tools: Map<string, ToolDefinition>, macroSchema: Record<string, unknown>): string {
  const toolList = Array.from(tools.entries())
    .map(([name, tool]) => `- ${name}: ${tool.description}`)
    .join('\n');

  return [
    'Your model endpoint does not support tool calls.',
    'Respond with ONLY a single JSON object and no markdown fences.',
    'The JSON must match this schema:',
    JSON.stringify(macroSchema),
    'The action object must contain exactly one tool name as its key.',
    'Available tools:',
    toolList,
  ].join('\n');
}

export class LLMClient {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  /**
   * Single LLM call → single tool execution → return result.
   * Uses the AgentOutput macro tool pattern for reflection-before-action.
   */
  async invoke(
    messages: Message[],
    tools: Map<string, ToolDefinition>,
    toolExecutor: (name: string, input: unknown) => Promise<string>,
    abortSignal?: AbortSignal,
  ): Promise<InvokeResult> {
    const macroSchema = buildMacroToolSchema(tools);
    const openaiTools = [{
      type: 'function',
      function: {
        name: 'AgentOutput',
        description: 'You MUST call this tool every step.',
        parameters: macroSchema,
      },
    }];

    const serializedMessages = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    const requestBody: Record<string, unknown> = {
      model: this.config.model,
      temperature: this.config.temperature,
      messages: serializedMessages,
      tools: openaiTools,
      tool_choice: { type: 'function', function: { name: 'AgentOutput' } },
      parallel_tool_calls: false,
    };

    let data: any;
    let rawRequest: Record<string, unknown> = requestBody;

    try {
      data = await this.callWithRetry(requestBody, abortSignal);
    } catch (error) {
      if (!this.supportsContentFallback(error)) {
        throw error;
      }

      const fallbackRequestBody: Record<string, unknown> = {
        model: this.config.model,
        temperature: this.config.temperature,
        messages: [
          ...serializedMessages,
          {
            role: 'user',
            content: buildContentFallbackInstruction(tools, macroSchema),
          },
        ],
      };

      rawRequest = fallbackRequestBody;
      data = await this.callWithRetry(fallbackRequestBody, abortSignal);
    }

    // Extract tool call
    const choice = data.choices?.[0];
    if (!choice) {
      throw new InvokeError(InvokeErrorType.UNKNOWN, 'No choices in response', undefined, data);
    }

    const toolCall = choice.message?.tool_calls?.[0];
    if (!toolCall?.function?.arguments) {
      // Try to parse from content if model doesn't support tool calling well
      const content = choice.message?.content;
      if (content) {
        return this.parseContentFallback(content, tools, toolExecutor, data, rawRequest);
      }
      throw new InvokeError(InvokeErrorType.NO_TOOL_CALL, 'No tool call in response', undefined, data);
    }

    // Parse macro tool arguments
    let macroInput: MacroToolInput;
    try {
      macroInput = JSON.parse(toolCall.function.arguments);
    } catch (e) {
      throw new InvokeError(InvokeErrorType.INVALID_TOOL_ARGS, 'Failed to parse tool arguments', e, data);
    }

    // Extract the action tool name and input
    const actionName = Object.keys(macroInput.action)[0];
    const actionInput = macroInput.action[actionName];

    if (!tools.has(actionName)) {
      throw new InvokeError(InvokeErrorType.INVALID_TOOL_ARGS, `Unknown tool: ${actionName}`, undefined, data);
    }

    // Execute the action
    let output: string;
    try {
      output = await toolExecutor(actionName, actionInput);
    } catch (e) {
      throw new InvokeError(
        InvokeErrorType.TOOL_EXECUTION_ERROR,
        `Tool ${actionName} failed: ${(e as Error).message}`,
        e, data,
      );
    }

    const result: MacroToolResult = { input: macroInput, output };

    return {
      toolCall: { name: actionName, args: actionInput },
      toolResult: result,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
        cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens,
      },
      rawResponse: data,
      rawRequest,
    };
  }

  private supportsContentFallback(error: unknown): boolean {
    return error instanceof InvokeError &&
      error.type === InvokeErrorType.UNKNOWN &&
      /does not support tools|tool/i.test(error.message);
  }

  private async callWithRetry(body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (signal?.aborted) throw new InvokeError(InvokeErrorType.NETWORK_ERROR, 'Aborted');

      if (attempt > 0) {
        logger.warn('LLM', `Retry attempt ${attempt}/${this.config.maxRetries}`);
        await new Promise(r => setTimeout(r, 500 * attempt));
      }

      try {
        const response = await fetch(`${this.config.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.config.apiKey && { Authorization: `Bearer ${this.config.apiKey}` }),
          },
          body: JSON.stringify(body),
          signal,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errorMsg = (errorData as any)?.error?.message ?? response.statusText;

          if (response.status === 401 || response.status === 403) {
            throw new InvokeError(InvokeErrorType.AUTH_ERROR, `Auth failed: ${errorMsg}`, errorData);
          }
          if (response.status === 429) {
            throw new InvokeError(InvokeErrorType.RATE_LIMIT, `Rate limited: ${errorMsg}`, errorData);
          }
          if (response.status >= 500) {
            throw new InvokeError(InvokeErrorType.SERVER_ERROR, `Server error: ${errorMsg}`, errorData);
          }
          throw new InvokeError(InvokeErrorType.UNKNOWN, `HTTP ${response.status}: ${errorMsg}`, errorData);
        }

        return await response.json();
      } catch (e) {
        if (e instanceof InvokeError && !e.retryable) throw e;
        if ((e as any)?.name === 'AbortError') {
          throw new InvokeError(InvokeErrorType.NETWORK_ERROR, 'Aborted', e);
        }
        lastError = e as Error;
      }
    }

    throw lastError ?? new InvokeError(InvokeErrorType.UNKNOWN, 'All retries exhausted');
  }

  /**
   * Fallback parser for models that put tool calls in content instead of tool_calls.
   */
  private async parseContentFallback(
    content: string,
    tools: Map<string, ToolDefinition>,
    toolExecutor: (name: string, input: unknown) => Promise<string>,
    rawResponse: unknown,
    rawRequest: unknown,
  ): Promise<InvokeResult> {
    // Try to extract JSON from content
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new InvokeError(InvokeErrorType.NO_TOOL_CALL, 'No tool call found in content');
    }

    let macroInput: MacroToolInput;
    try {
      macroInput = JSON.parse(jsonMatch[0]);
    } catch {
      throw new InvokeError(InvokeErrorType.INVALID_TOOL_ARGS, 'Failed to parse content as JSON');
    }

    if (!macroInput.action) {
      throw new InvokeError(InvokeErrorType.INVALID_TOOL_ARGS, 'No action in parsed content');
    }

    const actionName = Object.keys(macroInput.action)[0];
    const actionInput = macroInput.action[actionName];

    let output: string;
    try {
      output = await toolExecutor(actionName, actionInput);
    } catch (e) {
      throw new InvokeError(InvokeErrorType.TOOL_EXECUTION_ERROR, `Tool ${actionName} failed: ${(e as Error).message}`, e);
    }

    return {
      toolCall: { name: actionName, args: actionInput },
      toolResult: { input: macroInput, output } as MacroToolResult,
      usage: {
        promptTokens: (rawResponse as any)?.usage?.prompt_tokens ?? 0,
        completionTokens: (rawResponse as any)?.usage?.completion_tokens ?? 0,
        totalTokens: (rawResponse as any)?.usage?.total_tokens ?? 0,
      },
      rawResponse,
      rawRequest,
    };
  }
}
