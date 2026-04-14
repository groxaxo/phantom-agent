/**
 * Page controller — high-level browser interaction API.
 * Bridges CDP input primitives with indexed DOM elements from the perception layer.
 * Synthesized from page-agent's PageController + playwright's CRPage interaction patterns.
 */
import type { CDPSession } from '../browser/session.js';
import type { DomNode, BrowserState, ScrollOptions, HScrollOptions, PageControllerInterface } from '../types.js';
import { Mouse } from '../input/mouse.js';
import { Keyboard } from '../input/keyboard.js';
import { PageStateManager } from '../perception/page-state.js';
import { captureScreenshot } from '../perception/screenshot.js';
import { logger } from '../utils/logger.js';
import { humanDelay } from '../utils/helpers.js';

export class PageController implements PageControllerInterface {
  readonly mouse: Mouse;
  readonly keyboard: Keyboard;
  readonly stateManager: PageStateManager;
  private session: CDPSession;
  private enableVision: boolean;

  constructor(session: CDPSession, enableVision = false) {
    this.session = session;
    this.mouse = new Mouse(session);
    this.keyboard = new Keyboard(session);
    this.stateManager = new PageStateManager(session);
    this.enableVision = enableVision;
  }

  async getBrowserState(): Promise<BrowserState> {
    return this.stateManager.getBrowserState(this.enableVision);
  }

  /** Click an interactive element by its highlight index */
  async clickElement(index: number): Promise<{ message: string }> {
    const node = this.resolveElement(index);

    // Scroll element into view
    await this.scrollIntoView(index);
    await humanDelay(0.1);

    // Click at center of bounding box
    const box = node.boundingBox;
    if (!box) {
      // Fallback: click via JavaScript
      return this.clickViaJS(index);
    }

    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    logger.debug('Controller', `Clicking [${index}] <${node.tagName}> at (${x}, ${y})`);
    await this.mouse.click(x, y);
    await humanDelay(0.15);

    return { message: `✅ Clicked element [${index}] <${node.tagName}> "${node.textContent.slice(0, 50)}"` };
  }

  /** Type text into an input element by index */
  async inputText(index: number, text: string): Promise<{ message: string }> {
    const node = this.resolveElement(index);

    // Click to focus
    await this.clickElement(index);
    await humanDelay(0.1);

    // Clear existing content
    await this.session.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('[data-phantom-idx="${index}"]');
        if (el) {
          el.value = '';
          el.textContent = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()`,
    });

    // Type with human-like delays
    await this.keyboard.type(text, 40);

    return { message: `✅ Typed "${text.slice(0, 50)}" into element [${index}] <${node.tagName}>` };
  }

  /** Select a dropdown option by text */
  async selectOption(index: number, text: string): Promise<{ message: string }> {
    const node = this.resolveElement(index);

    const result = await this.session.send<{ result: { value: string } }>('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('[data-phantom-idx="${index}"]');
        if (!el) return 'Element not found';
        if (el.tagName === 'SELECT') {
          const option = Array.from(el.options).find(o =>
            o.text.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}) ||
            o.value.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})
          );
          if (option) {
            el.value = option.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return 'Selected: ' + option.text;
          }
          return 'Option not found: ${text}';
        }
        return 'Not a select element';
      })()`,
      returnByValue: true,
    });

    const msg = (result as any).result?.value ?? 'Selection attempted';
    return { message: `✅ ${msg}` };
  }

  /** Scroll the page or a specific element */
  async scroll(opts: ScrollOptions): Promise<{ message: string }> {
    const direction = opts.down ? 'down' : 'up';
    const pixels = opts.pixels ?? Math.round((opts.numPages ?? 1) * 600);
    const deltaY = opts.down ? pixels : -pixels;

    if (opts.index !== undefined) {
      // Scroll specific element
      const node = this.resolveElement(opts.index);
      const box = node.boundingBox;
      if (box) {
        await this.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      }
      await this.mouse.wheel(0, deltaY);
    } else {
      // Scroll page
      await this.mouse.wheel(0, deltaY);
    }

    await humanDelay(0.3);
    return { message: `✅ Scrolled ${direction} by ${Math.abs(pixels)}px` };
  }

  /** Scroll horizontally */
  async scrollHorizontally(opts: HScrollOptions): Promise<{ message: string }> {
    const deltaX = opts.right ? opts.pixels : -opts.pixels;
    const direction = opts.right ? 'right' : 'left';

    if (opts.index !== undefined) {
      const node = this.resolveElement(opts.index);
      const box = node.boundingBox;
      if (box) {
        await this.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      }
    }

    await this.mouse.wheel(deltaX, 0);
    await humanDelay(0.2);
    return { message: `✅ Scrolled ${direction} by ${opts.pixels}px` };
  }

  /** Execute arbitrary JavaScript in page context */
  async executeJavascript(script: string): Promise<{ message: string }> {
    try {
      const result = await this.session.send<{ result: { type: string; value: unknown; description?: string } }>(
        'Runtime.evaluate',
        {
          expression: script,
          returnByValue: true,
          awaitPromise: true,
        },
      );

      const val = (result as any).result;
      if (val?.type === 'undefined') return { message: '✅ Script executed (no return value)' };
      const output = val?.value !== undefined ? JSON.stringify(val.value) : (val?.description ?? 'done');
      return { message: `✅ Result: ${output.slice(0, 500)}` };
    } catch (e) {
      return { message: `❌ Script error: ${(e as Error).message}` };
    }
  }

  /** Take a screenshot and return base64 */
  async takeScreenshot(): Promise<string> {
    return captureScreenshot(this.session, { format: 'jpeg', quality: 70 });
  }

  /** Navigate to a URL */
  async navigate(url: string): Promise<{ message: string }> {
    await this.session.send('Page.navigate', { url });
    // Wait for load
    await this.session.send('Page.setLifecycleEventsEnabled', { enabled: true });
    await new Promise<void>((resolve) => {
      const handler = (params: any) => {
        if (params.name === 'load' || params.name === 'DOMContentLoaded') {
          this.session.removeListener('Page.lifecycleEvent', handler);
          resolve();
        }
      };
      this.session.on('Page.lifecycleEvent', handler);
      setTimeout(resolve, 10000); // timeout safety
    });
    return { message: `✅ Navigated to ${url}` };
  }

  /** Go back in browser history */
  async goBack(): Promise<{ message: string }> {
    const history = await this.session.send<{ currentIndex: number; entries: Array<{ url: string }> }>(
      'Page.getNavigationHistory',
    );
    if (history.currentIndex > 0) {
      const entry = history.entries[history.currentIndex - 1];
      await this.session.send('Page.navigateToHistoryEntry', { entryId: (entry as any).id });
      await humanDelay(1);
      return { message: `✅ Navigated back to ${entry.url}` };
    }
    return { message: '⚠️ No previous page in history' };
  }

  /** Press Enter key */
  async pressEnter(): Promise<{ message: string }> {
    await this.keyboard.press('Enter');
    return { message: '✅ Pressed Enter' };
  }

  getLastUpdateTime(): number {
    return this.stateManager.getLastUpdateTime();
  }

  // ─── Private Helpers ─────────────────────────────────────────

  private resolveElement(index: number): DomNode {
    const map = this.stateManager.getSelectorMap();
    const node = map.get(index);
    if (!node) {
      throw new Error(`Element [${index}] not found. It may have been removed or is offscreen. Try scrolling or re-observing.`);
    }
    return node;
  }

  private async scrollIntoView(index: number): Promise<void> {
    await this.session.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('[data-phantom-idx="${index}"]');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      })()`,
    });
    await humanDelay(0.2);
  }

  private async clickViaJS(index: number): Promise<{ message: string }> {
    await this.session.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('[data-phantom-idx="${index}"]');
        if (el) {
          el.focus();
          el.click();
        }
      })()`,
    });
    return { message: `✅ Clicked element [${index}] via JavaScript fallback` };
  }
}
