/**
 * CDP keyboard input emulation.
 * Synthesized from playwright's RawKeyboardImpl — dispatches key events at the protocol level.
 */
import type { CDPSession } from '../browser/session.js';
import type { KeyDescription, KeyboardModifier } from '../types.js';
import { humanDelay } from '../utils/helpers.js';

const MODIFIER_BIT: Record<string, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

function toModifiersMask(modifiers: Set<KeyboardModifier>): number {
  let mask = 0;
  for (const mod of modifiers) mask |= MODIFIER_BIT[mod] ?? 0;
  return mask;
}

/** Key name → key description mapping for common keys */
const KEY_DEFINITIONS: Record<string, Partial<KeyDescription>> = {
  Enter:     { key: 'Enter',     code: 'Enter',     keyCode: 13, text: '\r' },
  Tab:       { key: 'Tab',       code: 'Tab',       keyCode: 9,  text: '' },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8,  text: '' },
  Delete:    { key: 'Delete',    code: 'Delete',    keyCode: 46, text: '' },
  Escape:    { key: 'Escape',    code: 'Escape',    keyCode: 27, text: '' },
  ArrowUp:   { key: 'ArrowUp',   code: 'ArrowUp',   keyCode: 38, text: '' },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, text: '' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, text: '' },
  ArrowRight:{ key: 'ArrowRight',code: 'ArrowRight',keyCode: 39, text: '' },
  Home:      { key: 'Home',      code: 'Home',      keyCode: 36, text: '' },
  End:       { key: 'End',       code: 'End',       keyCode: 35, text: '' },
  PageUp:    { key: 'PageUp',    code: 'PageUp',    keyCode: 33, text: '' },
  PageDown:  { key: 'PageDown',  code: 'PageDown',  keyCode: 34, text: '' },
  Space:     { key: ' ',         code: 'Space',     keyCode: 32, text: ' ' },
};

export class Keyboard {
  private session: CDPSession;
  private modifiers = new Set<KeyboardModifier>();

  constructor(session: CDPSession) {
    this.session = session;
  }

  async keyDown(key: string): Promise<void> {
    const desc = this.descriptionForKey(key);
    if (['Alt', 'Control', 'Meta', 'Shift'].includes(key)) {
      this.modifiers.add(key as KeyboardModifier);
    }
    await this.session.send('Input.dispatchKeyEvent', {
      type: desc.text ? 'keyDown' : 'rawKeyDown',
      modifiers: toModifiersMask(this.modifiers),
      windowsVirtualKeyCode: desc.keyCode,
      code: desc.code,
      key: desc.key,
      text: desc.text,
      unmodifiedText: desc.text,
      autoRepeat: false,
      location: desc.location ?? 0,
    });
  }

  async keyUp(key: string): Promise<void> {
    const desc = this.descriptionForKey(key);
    this.modifiers.delete(key as KeyboardModifier);
    await this.session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: toModifiersMask(this.modifiers),
      key: desc.key,
      windowsVirtualKeyCode: desc.keyCode,
      code: desc.code,
      location: desc.location ?? 0,
    });
  }

  /** Press and release a key */
  async press(key: string): Promise<void> {
    await this.keyDown(key);
    await humanDelay(30, 0.5);
    await this.keyUp(key);
  }

  /** Type a string character by character with human-like delays */
  async type(text: string, delayMs = 50): Promise<void> {
    for (const char of text) {
      if (char.length === 1 && char.charCodeAt(0) >= 32) {
        // Printable character — use insertText for reliability
        await this.session.send('Input.insertText', { text: char });
      } else {
        await this.press(char);
      }
      await humanDelay(delayMs, 0.4);
    }
  }

  /** Send raw text insertion (bypasses key events) */
  async insertText(text: string): Promise<void> {
    await this.session.send('Input.insertText', { text });
  }

  private descriptionForKey(key: string): KeyDescription {
    if (KEY_DEFINITIONS[key]) {
      const d = KEY_DEFINITIONS[key];
      return {
        key: d.key ?? key,
        code: d.code ?? key,
        keyCode: d.keyCode ?? 0,
        keyCodeWithoutLocation: d.keyCode ?? 0,
        text: d.text ?? '',
        location: 0,
      };
    }
    // Single character
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
    const keyCode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
    return {
      key,
      code,
      keyCode,
      keyCodeWithoutLocation: keyCode,
      text: key.length === 1 ? key : '',
      location: 0,
    };
  }
}
