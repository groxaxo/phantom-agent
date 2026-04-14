/**
 * CDP mouse input emulation with human-like movement.
 * Synthesized from playwright's RawMouseImpl + Bézier curve interpolation.
 */
import type { CDPSession } from '../browser/session.js';
import type { MouseButton, KeyboardModifier } from '../types.js';
import { bezierPath, humanDelay, clamp, gaussianRandom } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

const BUTTON_MAP: Record<string, string> = {
  left: 'left',
  right: 'right',
  middle: 'middle',
};

const BUTTON_MASK: Record<string, number> = {
  left: 1,
  right: 2,
  middle: 4,
};

function toModifiersMask(modifiers: Set<KeyboardModifier>): number {
  let mask = 0;
  const bits: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  for (const m of modifiers) mask |= bits[m] ?? 0;
  return mask;
}

export class Mouse {
  private session: CDPSession;
  private x = 0;
  private y = 0;
  private buttons = new Set<MouseButton>();
  private modifiers = new Set<KeyboardModifier>();

  constructor(session: CDPSession) {
    this.session = session;
  }

  /** Move mouse to target coordinates along a natural Bézier curve */
  async move(targetX: number, targetY: number, options?: { steps?: number }): Promise<void> {
    const distance = Math.sqrt((targetX - this.x) ** 2 + (targetY - this.y) ** 2);
    const steps = options?.steps ?? clamp(Math.ceil(distance / 15), 5, 40);

    const path = bezierPath(this.x, this.y, targetX, targetY, steps);

    for (const point of path) {
      await this.session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x,
        y: point.y,
        button: 'none',
        buttons: this.buttonsMask(),
        modifiers: toModifiersMask(this.modifiers),
      });
      // Variable inter-step delay for human realism
      const delay = Math.max(2, gaussianRandom(8, 3));
      await new Promise((r) => setTimeout(r, delay));
    }

    this.x = targetX;
    this.y = targetY;
  }

  /** Click at current position or move to target first */
  async click(x?: number, y?: number, options?: {
    button?: MouseButton;
    clickCount?: number;
    delay?: number;
  }): Promise<void> {
    const button = options?.button ?? 'left';
    const clickCount = options?.clickCount ?? 1;
    const delay = options?.delay ?? Math.max(30, gaussianRandom(70, 20));

    if (x !== undefined && y !== undefined) {
      await this.move(x, y);
    }

    await this.down(button, clickCount);
    await humanDelay(delay / 1000, 0.3);
    await this.up(button, clickCount);
  }

  /** Double-click */
  async dblclick(x?: number, y?: number): Promise<void> {
    if (x !== undefined && y !== undefined) {
      await this.move(x, y);
    }
    await this.click(undefined, undefined, { clickCount: 1 });
    await humanDelay(0.08, 0.3);
    await this.click(undefined, undefined, { clickCount: 2 });
  }

  async down(button: MouseButton = 'left', clickCount = 1): Promise<void> {
    this.buttons.add(button);
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: BUTTON_MAP[button],
      buttons: this.buttonsMask(),
      x: this.x,
      y: this.y,
      clickCount,
      modifiers: toModifiersMask(this.modifiers),
      force: 0.5,
    });
  }

  async up(button: MouseButton = 'left', clickCount = 1): Promise<void> {
    this.buttons.delete(button);
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: BUTTON_MAP[button],
      buttons: this.buttonsMask(),
      x: this.x,
      y: this.y,
      clickCount,
      modifiers: toModifiersMask(this.modifiers),
    });
  }

  /** Scroll wheel at current position */
  async wheel(deltaX: number, deltaY: number): Promise<void> {
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: this.x,
      y: this.y,
      deltaX,
      deltaY,
      modifiers: toModifiersMask(this.modifiers),
    });
  }

  getPosition(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  private buttonsMask(): number {
    let mask = 0;
    for (const b of this.buttons) mask |= BUTTON_MASK[b] ?? 0;
    return mask;
  }
}
