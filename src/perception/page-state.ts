/**
 * Page state assembly — orchestrates DOM extraction, serialization,
 * and screenshot capture into a unified BrowserState for LLM consumption.
 */
import type { CDPSession } from '../browser/session.js';
import type { BrowserState, FlatDomTree, DomNode } from '../types.js';
import { DOM_EXTRACTION_SCRIPT } from './dom-extractor.js';
import { serializeDomTree, type PageInfo, type SerializedPage } from './dom-serializer.js';
import { captureScreenshot } from './screenshot.js';
import { logger } from '../utils/logger.js';

export class PageStateManager {
  private session: CDPSession;
  private previousIndexes = new Set<number>();
  private lastSerialized: SerializedPage | null = null;
  private lastUpdateTime = Date.now();

  constructor(session: CDPSession) {
    this.session = session;
  }

  /**
   * Extract current page state for LLM reasoning.
   */
  async getBrowserState(includeScreenshot = false): Promise<BrowserState> {
    // Extract DOM tree by evaluating script in page context
    const { tree, pageInfo } = await this.extractDomTree();

    // Serialize for LLM
    const serialized = serializeDomTree(tree, pageInfo, this.previousIndexes);
    this.lastSerialized = serialized;
    this.lastUpdateTime = Date.now();

    // Update previous indexes for next-step diffing
    this.previousIndexes = new Set(serialized.selectorMap.keys());

    const state: BrowserState = {
      url: pageInfo.url,
      title: pageInfo.title,
      header: serialized.header,
      content: serialized.content,
      footer: serialized.footer,
    };

    if (includeScreenshot) {
      try {
        state.screenshot = await captureScreenshot(this.session, {
          format: 'jpeg',
          quality: 60,
        });
      } catch (e) {
        logger.warn('PageState', `Screenshot failed: ${(e as Error).message}`);
      }
    }

    return state;
  }

  /** Get selector map for element interaction */
  getSelectorMap(): Map<number, DomNode> {
    return this.lastSerialized?.selectorMap ?? new Map();
  }

  getLastUpdateTime(): number {
    return this.lastUpdateTime;
  }

  private async extractDomTree(): Promise<{ tree: FlatDomTree; pageInfo: PageInfo }> {
    try {
      const result = await this.session.send<{ result: { type: string; value: string } }>(
        'Runtime.evaluate',
        {
          expression: DOM_EXTRACTION_SCRIPT,
          returnByValue: true,
          awaitPromise: false,
        },
      );

      const raw = (result as any).result?.value ?? (result as any).value;
      if (!raw) throw new Error('Empty DOM extraction result');

      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return {
        tree: { rootId: parsed.rootId, map: parsed.map },
        pageInfo: parsed.pageInfo,
      };
    } catch (e) {
      logger.error('PageState', `DOM extraction failed: ${(e as Error).message}`);
      // Return empty state on failure
      return {
        tree: { rootId: '', map: {} },
        pageInfo: {
          url: 'unknown',
          title: 'unknown',
          viewportWidth: 0,
          viewportHeight: 0,
          scrollX: 0,
          scrollY: 0,
          scrollWidth: 0,
          scrollHeight: 0,
        },
      };
    }
  }
}
