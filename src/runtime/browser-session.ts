import { buildConfig } from '../config.js';
import { launchBrowser, type BrowserInstance } from '../browser/launcher.js';
import { PageController } from '../actions/page-controller.js';
import type { AgentConfig } from '../types.js';

export interface BrowserSessionHandle {
  config: AgentConfig;
  browser: BrowserInstance;
  pageController: PageController;
  close(): Promise<void>;
}

export async function openBrowserSession(configOverrides: Partial<AgentConfig> = {}): Promise<BrowserSessionHandle> {
  const config = buildConfig(configOverrides);
  const browser = await launchBrowser(config.browser, config.stealth);

  const targets = await browser.connection.rootSession.send<{
    targetInfos: Array<{ targetId: string; type: string; url: string }>;
  }>('Target.getTargets');

  let pageTarget = targets.targetInfos.find((target) => target.type === 'page');

  if (!pageTarget) {
    const result = await browser.connection.rootSession.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
    });
    pageTarget = { targetId: result.targetId, type: 'page', url: 'about:blank' };
  }

  const pageSession = await browser.connection.createSession(pageTarget.targetId);

  await Promise.all([
    pageSession.send('Page.enable'),
    pageSession.send('Runtime.enable'),
    pageSession.send('DOM.enable'),
    pageSession.send('Network.enable'),
  ]);

  const pageController = new PageController(pageSession, config.enableVision);

  return {
    config,
    browser,
    pageController,
    close: async () => {
      await browser.close();
    },
  };
}
