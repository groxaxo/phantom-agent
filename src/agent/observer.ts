/**
 * ObserverClient — cheap DOM summarizer that sits between page observation
 * and the actor LLM call.
 *
 * The observer receives the raw browser state (verbose DOM with [N] indices)
 * and returns a compact structured summary.  The actor model sees the summary
 * instead of the raw DOM, cutting its context by ~70-75%.
 *
 * CRITICAL: element indices [N] MUST be preserved in the summary so the actor
 * can still call click_element_by_index, input_text, select_dropdown_option, etc.
 */

import type { LLMConfig, BrowserState, TokenUsage } from '../types.js';
import { logger } from '../utils/logger.js';

const OBSERVER_SYSTEM_PROMPT = `You are a DOM observer for a browser automation agent. Your job is to convert a verbose DOM snapshot into a compact, structured summary.

CRITICAL RULE: You MUST preserve all element indices in square brackets [N] EXACTLY as they appear in the input. The agent uses these numbers to interact with the page (click, type, scroll, etc.). If an index is missing from your summary, the agent cannot use that element.

Output a concise summary (15-40 lines) in this format:

URL: <current page url>
Title: <page title>

Interactive elements:
  [N]<tag>label or description</tag>
  ... (list every interactive element with its index)

Key content:
  <important visible text, values, search results, data, status messages, etc.>

Notes: <page load state, errors, popups, or anything unusual — omit if nothing notable>

Keep it short. Do not repeat the same information. Skip decorative or structural elements that have no meaningful label.`;

export interface ObserverSummary {
  summary: string;
  usage: TokenUsage;
}

export class ObserverClient {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  /**
   * Summarize a browser state into a compact structured representation.
   * Returns the summary text and token usage for cost tracking.
   */
  async summarize(browserState: BrowserState): Promise<ObserverSummary> {
    const rawContent = [
      browserState.header,
      browserState.content,
      browserState.footer,
    ].filter(Boolean).join('\n');

    const requestBody = {
      model: this.config.model,
      temperature: this.config.temperature,
      messages: [
        { role: 'system', content: OBSERVER_SYSTEM_PROMPT },
        { role: 'user', content: rawContent },
      ],
    };

    let data: any;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        logger.warn('Observer', `Retry attempt ${attempt}/${this.config.maxRetries}`);
        await new Promise(r => setTimeout(r, 400 * attempt));
      }

      const response = await fetch(`${this.config.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey && { Authorization: `Bearer ${this.config.apiKey}` }),
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const msg = (err as any)?.error?.message ?? response.statusText;
        if (response.status >= 500 && attempt < this.config.maxRetries) continue;
        throw new Error(`Observer LLM error ${response.status}: ${msg}`);
      }

      data = await response.json();
      break;
    }

    if (!data) throw new Error('Observer: all retries exhausted');

    const summary: string = data.choices?.[0]?.message?.content ?? '';

    const usage: TokenUsage = {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
      cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens,
    };

    logger.debug('Observer', `Summary (${usage.totalTokens} tok): ${summary.slice(0, 300)}`);

    return { summary, usage };
  }
}
