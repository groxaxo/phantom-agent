import { AgentCore } from '../agent/core.js';
import type { AgentConfig, ExecutionResult } from '../types.js';
import { openBrowserSession } from './browser-session.js';

export interface TaskRunnerOptions {
  task: string;
  configOverrides?: Partial<AgentConfig>;
}

export interface TaskRunHandle {
  config: AgentConfig;
  stop(): void;
  completed: Promise<ExecutionResult>;
}

export async function startTaskRun(options: TaskRunnerOptions): Promise<TaskRunHandle> {
  if (!options.task.trim()) {
    throw new Error('Task is required');
  }

  const session = await openBrowserSession(options.configOverrides);
  const { config, pageController } = session;
  const agent = new AgentCore(config, pageController);

  const completed = (async () => {
    try {
      return await agent.execute(options.task);
    } finally {
      await session.close();
    }
  })();

  return {
    config,
    stop: () => agent.stop(),
    completed,
  };
}
