/**
 * Stealth patches injected into every new page via CDP.
 * These scripts run before any page JavaScript to prevent
 * automation detection via common fingerprinting vectors.
 */
import type { StealthConfig } from '../types.js';
import type { CDPSession } from './session.js';
import { logger } from '../utils/logger.js';

/**
 * Compile all stealth scripts and inject them into the target.
 */
export async function injectStealthScripts(session: CDPSession, config: StealthConfig): Promise<void> {
  const scripts = [
    patchWebdriver(),
    patchChrome(),
    patchPermissions(),
    patchPlugins(),
    patchWebGL(config.webglVendor, config.webglRenderer),
    patchCanvas(),
    patchNavigator(config),
    patchCDP(),
    patchConsole(),
  ];

  for (const script of scripts) {
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: script });
  }

  // Set timezone and locale via CDP Emulation domain
  if (config.timezone) {
    await session.sendMayFail('Emulation.setTimezoneOverride', {
      timezoneId: config.timezone,
    });
  }
  if (config.locale) {
    await session.sendMayFail('Emulation.setLocaleOverride', {
      locale: config.locale,
    });
  }

  logger.info('Stealth', 'All stealth patches injected');
}

// ─── Individual Patch Functions ──────────────────────────────

/** Remove navigator.webdriver flag */
function patchWebdriver(): string {
  return `
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
    // Also delete from prototype
    delete Object.getPrototypeOf(navigator).webdriver;
  `;
}

/** Add window.chrome object that automation tools typically strip */
function patchChrome(): string {
  return `
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        connect: function() {},
        sendMessage: function() {},
        onMessage: { addListener: function() {}, removeListener: function() {} },
        PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
        PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
        PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
        RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
      };
    }
    if (!window.chrome.loadTimes) {
      window.chrome.loadTimes = function() {
        return {
          commitLoadTime: Date.now() / 1000,
          connectionInfo: 'h2',
          finishDocumentLoadTime: Date.now() / 1000 + 0.1,
          finishLoadTime: Date.now() / 1000 + 0.2,
          firstPaintAfterLoadTime: 0,
          firstPaintTime: Date.now() / 1000 + 0.05,
          navigationType: 'Other',
          npnNegotiatedProtocol: 'h2',
          requestTime: Date.now() / 1000 - 0.5,
          startLoadTime: Date.now() / 1000 - 0.4,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
        };
      };
    }
    if (!window.chrome.csi) {
      window.chrome.csi = function() {
        return {
          onloadT: Date.now(),
          startE: Date.now() - 500,
          pageT: 500,
          tran: 15,
        };
      };
    }
  `;
}

/** Override Permissions API to report 'prompt' for notifications */
function patchPermissions(): string {
  return `
    const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
    if (originalQuery) {
      window.navigator.permissions.query = function(parameters) {
        return parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : originalQuery(parameters);
      };
    }
  `;
}

/** Ensure navigator.plugins has realistic entries */
function patchPlugins(): string {
  return `
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        arr.refresh = function() {};
        arr.item = function(i) { return this[i] || null; };
        arr.namedItem = function(name) { return this.find(p => p.name === name) || null; };
        Object.setPrototypeOf(arr, PluginArray.prototype);
        return arr;
      },
    });
    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => {
        const arr = [
          { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: navigator.plugins[0] },
        ];
        arr.item = function(i) { return this[i] || null; };
        arr.namedItem = function(t) { return this.find(m => m.type === t) || null; };
        Object.setPrototypeOf(arr, MimeTypeArray.prototype);
        return arr;
      },
    });
  `;
}

/** Spoof WebGL vendor and renderer to mask GPU fingerprint */
function patchWebGL(vendor: string, renderer: string): string {
  return `
    const getParameterProto = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      const UNMASKED_VENDOR = 0x9245;
      const UNMASKED_RENDERER = 0x9246;
      if (parameter === UNMASKED_VENDOR) return ${JSON.stringify(vendor)};
      if (parameter === UNMASKED_RENDERER) return ${JSON.stringify(renderer)};
      return getParameterProto.call(this, parameter);
    };
    const getParameterProto2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(parameter) {
      const UNMASKED_VENDOR = 0x9245;
      const UNMASKED_RENDERER = 0x9246;
      if (parameter === UNMASKED_VENDOR) return ${JSON.stringify(vendor)};
      if (parameter === UNMASKED_RENDERER) return ${JSON.stringify(renderer)};
      return getParameterProto2.call(this, parameter);
    };
  `;
}

/** Add subtle noise to canvas toDataURL/toBlob to defeat canvas fingerprinting */
function patchCanvas(): string {
  return `
    const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
      // Inject 1px of noise only for fingerprint-sized canvases
      if (this.width <= 500 && this.height <= 500) {
        const ctx = this.getContext('2d');
        if (ctx) {
          const style = ctx.fillStyle;
          ctx.fillStyle = 'rgba(0,0,' + Math.floor(Math.random() * 4) + ',0.01)';
          ctx.fillRect(
            Math.floor(Math.random() * this.width),
            Math.floor(Math.random() * this.height),
            1, 1
          );
          ctx.fillStyle = style;
        }
      }
      return _toDataURL.call(this, type, quality);
    };
  `;
}

/** Override navigator properties for consistent fingerprint */
function patchNavigator(config: StealthConfig): string {
  return `
    Object.defineProperties(navigator, {
      hardwareConcurrency: { get: () => ${config.hardwareConcurrency} },
      deviceMemory: { get: () => ${config.deviceMemory} },
      maxTouchPoints: { get: () => ${config.maxTouchPoints} },
      platform: { get: () => ${JSON.stringify(config.platform)} },
      vendor: { get: () => ${JSON.stringify(config.vendor)} },
      languages: { get: () => ${JSON.stringify(config.languages)} },
      language: { get: () => ${JSON.stringify(config.languages[0])} },
    });
  `;
}

/** Prevent detection of CDP via Runtime domain inspection */
function patchCDP(): string {
  return `
    // Mask Runtime.enable artifacts
    const _Error = Error;
    const _getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

    // Prevent stack trace-based CDP detection
    const _prepareStackTrace = _Error.prepareStackTrace;
    Object.defineProperty(_Error, 'prepareStackTrace', {
      get: () => _prepareStackTrace,
      set: (v) => {
        // Block attempts to instrument stack traces for CDP sniffing
        if (typeof v === 'function' && v.toString().includes('Runtime')) return;
        _prepareStackTrace = v;
      },
    });

    // Mask __cdp_binding__ / __playwright_ bindings
    const _getOwnPropertyNames = Object.getOwnPropertyNames;
    Object.getOwnPropertyNames = function(obj) {
      const names = _getOwnPropertyNames(obj);
      return names.filter(n => !n.startsWith('__cdp') && !n.startsWith('__playwright'));
    };
  `;
}

/** Ensure console.debug doesn't leak CDP logging */
function patchConsole(): string {
  return `
    // Some detection scripts check if console is patched
    const _console = window.console;
    if (_console) {
      window.console = new Proxy(_console, {
        get: (target, prop) => {
          if (prop === 'debug') {
            return function(...args) {
              // Filter CDP-related debug messages
              const str = args.join(' ');
              if (str.includes('Runtime.') || str.includes('Target.')) return;
              return target.debug.apply(target, args);
            };
          }
          return target[prop];
        }
      });
    }
  `;
}
