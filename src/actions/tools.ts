/**
 * Tool registry for the autonomous agent.
 * Synthesized from page-agent's tool definitions — each tool maps to
 * a PageController method and provides a JSON schema for LLM invocation.
 */
import type { ToolDefinition, ToolContext } from '../types.js';
import { waitFor } from '../utils/helpers.js';

/** All available agent tools, keyed by name */
export function createToolRegistry(): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();

  tools.set('done', {
    description: 'Complete the task. Text is your final response — keep it concise unless detail is requested.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Final response to user' },
        success: { type: 'boolean', description: 'Whether task was completed successfully', default: true },
      },
      required: ['text'],
    },
    execute: async () => 'Task completed',
  });

  tools.set('wait', {
    description: 'Wait for x seconds. Use to wait for page or data to fully load.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', minimum: 1, maximum: 10, default: 1 },
      },
      required: ['seconds'],
    },
    execute: async (input: any, ctx: ToolContext) => {
      const lastUpdate = ctx.pageController.getLastUpdateTime?.() ?? Date.now();
      const elapsed = (Date.now() - lastUpdate) / 1000;
      const actual = Math.max(0, (input.seconds ?? 1) - elapsed);
      await waitFor(actual);
      return `✅ Waited for ${input.seconds} seconds.`;
    },
  });

  tools.set('click_element_by_index', {
    description: 'Click an interactive element by its index number.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', minimum: 0 },
      },
      required: ['index'],
    },
    execute: async (input: any, ctx: ToolContext) => {
      const result = await ctx.pageController.clickElement(input.index);
      return result.message;
    },
  });

  tools.set('input_text', {
    description: 'Click and type text into an interactive input element.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', minimum: 0 },
        text: { type: 'string' },
      },
      required: ['index', 'text'],
    },
    execute: async (input: any, ctx: ToolContext) => {
      const result = await ctx.pageController.inputText(input.index, input.text);
      return result.message;
    },
  });

  tools.set('select_dropdown_option', {
    description: 'Select dropdown option by the text of the option you want to select.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', minimum: 0 },
        text: { type: 'string' },
      },
      required: ['index', 'text'],
    },
    execute: async (input: any, ctx: ToolContext) => {
      const result = await ctx.pageController.selectOption(input.index, input.text);
      return result.message;
    },
  });

  tools.set('scroll', {
    description: 'Scroll vertically. Without index: scrolls the document. With index: scrolls a specific container.',
    parameters: {
      type: 'object',
      properties: {
        down: { type: 'boolean', default: true },
        num_pages: { type: 'number', minimum: 0, maximum: 10, default: 0.5 },
        pixels: { type: 'integer', minimum: 0 },
        index: { type: 'integer', minimum: 0, description: 'Element index for container scrolling' },
      },
      required: ['down'],
    },
    execute: async (input: any, ctx: ToolContext) => {
      const result = await ctx.pageController.scroll({
        down: input.down ?? true,
        numPages: input.num_pages,
        pixels: input.pixels,
        index: input.index,
      });
      return result.message;
    },
  });

  tools.set('scroll_horizontally', {
    description: 'Scroll horizontally. Without index: scrolls the document. With index: scrolls a specific container.',
    parameters: {
      type: 'object',
      properties: {
        right: { type: 'boolean', default: true },
        pixels: { type: 'integer', minimum: 0 },
        index: { type: 'integer', minimum: 0 },
      },
      required: ['right', 'pixels'],
    },
    execute: async (input: any, ctx: ToolContext) => {
      const result = await ctx.pageController.scrollHorizontally(input);
      return result.message;
    },
  });

  tools.set('go_back', {
    description: 'Navigate back to the previous page in browser history.',
    parameters: { type: 'object', properties: {} },
    execute: async (_input: any, ctx: ToolContext) => {
      const pc = ctx.pageController as any;
      if (pc.goBack) {
        const result = await pc.goBack();
        return result.message;
      }
      return '⚠️ Navigation back not supported';
    },
  });

  tools.set('press_enter', {
    description: 'Press the Enter key. Use after typing into search fields or forms.',
    parameters: { type: 'object', properties: {} },
    execute: async (_input: any, ctx: ToolContext) => {
      const pc = ctx.pageController as any;
      if (pc.pressEnter) {
        const result = await pc.pressEnter();
        return result.message;
      }
      return '⚠️ Press enter not supported';
    },
  });

  tools.set('execute_javascript', {
    description: 'Execute JavaScript code on the current page. Supports async/await. Use with caution.',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string' },
      },
      required: ['script'],
    },
    execute: async (input: any, ctx: ToolContext) => {
      const result = await ctx.pageController.executeJavascript(input.script);
      return result.message;
    },
  });

  tools.set('ask_user', {
    description: 'Ask the user a question and wait for their answer. Use if you need more information.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
      },
      required: ['question'],
    },
    execute: async (input: any, ctx: ToolContext) => {
      if (!ctx.onAskUser) throw new Error('ask_user not available');
      const answer = await ctx.onAskUser(input.question);
      return `User answered: ${answer}`;
    },
  });

  return tools;
}
