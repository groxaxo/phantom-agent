/**
 * Chrome process launcher with stealth-optimized flags.
 * Synthesized from playwright's chromiumSwitches + chrome-devtools-mcp's browser.ts.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, rmSync, symlinkSync, lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import http from 'node:http';
import { logger } from '../utils/logger.js';
import { WebSocketTransport } from './transport.js';
import { CDPConnection } from './session.js';
import { injectStealthScripts } from './stealth.js';
import type { BrowserLaunchOptions, StealthConfig } from '../types.js';

/** Features to disable in Chromium for stealth + stability */
const DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'BoundaryEventDispatchTracksNodeRemoval',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
];

const CHROME_CANDIDATES = [
  {
    executablePath: '/usr/bin/google-chrome-stable',
    userDataDir: join(homedir(), '.config/google-chrome'),
  },
  {
    executablePath: '/usr/bin/google-chrome',
    userDataDir: join(homedir(), '.config/google-chrome'),
  },
  {
    executablePath: '/usr/bin/chromium-browser',
    userDataDir: join(homedir(), '.config/chromium'),
  },
  {
    executablePath: '/usr/bin/chromium',
    userDataDir: join(homedir(), '.config/chromium'),
  },
  {
    executablePath: '/snap/bin/chromium',
    userDataDir: join(homedir(), '.config/chromium'),
  },
  {
    executablePath: '/usr/bin/microsoft-edge-stable',
    userDataDir: join(homedir(), '.config/microsoft-edge'),
  },
] as const;

const PROFILE_DIRECTORY_PATTERN = /^(Default|Profile \d+|Guest Profile|System Profile)$/;

/** Base Chrome flags for automation + stealth */
function buildChromeArgs(options: BrowserLaunchOptions): string[] {
  const args = [
    // Stability & automation
    '--disable-field-trial-config',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-back-forward-cache',
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-component-extensions-with-background-pages',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    '--disable-infobars',
    '--disable-search-engine-choice-screen',
    `--disable-features=${DISABLED_FEATURES.join(',')}`,
    '--enable-features=CDPScreenshotNewSurface',

    // Stealth-specific
    '--no-default-browser-check',
    '--no-first-run',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    '--force-color-profile=srgb',
    '--metrics-recording-only',
    '--export-tagged-pdf',
    '--allow-pre-commit-input',

    // Automation flags that DON'T trigger detection
    // Note: we intentionally avoid --enable-automation and --disable-blink-features=AutomationControlled
    // is NOT needed when launching without --enable-automation
    `--window-size=${options.viewport.width},${options.viewport.height}`,

    // Remote debugging
    '--remote-debugging-port=0', // auto-assign port
  ];

  if (options.headless) {
    args.push('--headless=new');
  }

  if (options.userAgent) {
    args.push(`--user-agent=${options.userAgent}`);
  }

  if (options.userDataDir) {
    args.push(`--user-data-dir=${options.userDataDir}`);
  }

  if (options.profileDirectory) {
    args.push(`--profile-directory=${options.profileDirectory}`);
  }

  if (options.args) {
    args.push(...options.args);
  }

  return args;
}

/** Find Chromium executable on Linux */
function resolveChromeInstallation(executablePath?: string): { executablePath: string; defaultUserDataDir?: string } {
  if (executablePath) {
    if (!existsSync(executablePath)) {
      throw new Error(`Chrome executable not found: ${executablePath}`);
    }

    return {
      executablePath,
      defaultUserDataDir: inferDefaultUserDataDir(executablePath),
    };
  }

  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate.executablePath)) {
      return candidate;
    }
  }

  throw new Error(
    'Chromium not found. Install with: apt install chromium-browser, or set CHROME_PATH.',
  );
}

function inferDefaultUserDataDir(executablePath: string): string | undefined {
  const lowerPath = executablePath.toLowerCase();
  const prioritizedCandidates = [...CHROME_CANDIDATES].sort((left, right) => {
    const leftScore = lowerPath.includes(basename(left.executablePath).toLowerCase()) ? 0 : 1;
    const rightScore = lowerPath.includes(basename(right.executablePath).toLowerCase()) ? 0 : 1;
    return leftScore - rightScore;
  });

  return prioritizedCandidates.find((candidate) => existsSync(candidate.userDataDir))?.userDataDir;
}

function normalizeProfileSelection(
  userDataDir: string,
  profileDirectory?: string,
): { userDataDir: string; profileDirectory?: string } {
  if (profileDirectory) {
    return { userDataDir, profileDirectory };
  }

  const directoryName = basename(userDataDir);
  if (PROFILE_DIRECTORY_PATTERN.test(directoryName)) {
    return {
      userDataDir: dirname(userDataDir),
      profileDirectory: directoryName,
    };
  }

  return { userDataDir };
}

function detectLastUsedProfile(userDataDir: string): string | undefined {
  const localStatePath = join(userDataDir, 'Local State');
  if (!existsSync(localStatePath)) {
    return undefined;
  }

  try {
    const localState = JSON.parse(readFileSync(localStatePath, 'utf-8')) as {
      profile?: {
        last_used?: unknown;
        last_active_profiles?: unknown;
      };
    };

    if (typeof localState.profile?.last_used === 'string' && localState.profile.last_used.trim()) {
      return localState.profile.last_used;
    }

    if (Array.isArray(localState.profile?.last_active_profiles)) {
      const firstProfile = localState.profile.last_active_profiles.find(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      );
      if (firstProfile) {
        return firstProfile;
      }
    }
  } catch (error) {
    logger.debug('Launcher', `Failed to read Local State from ${localStatePath}: ${(error as Error).message}`);
  }

  return undefined;
}

function resolveLaunchProfile(
  options: BrowserLaunchOptions,
  defaultUserDataDir?: string,
): { userDataDir: string; profileDirectory?: string; isEphemeral: boolean; usingSystemProfile: boolean } {
  const selectedUserDataDir =
    options.userDataDir ||
    (defaultUserDataDir && existsSync(defaultUserDataDir) ? defaultUserDataDir : undefined) ||
    join(tmpdir(), `phantom-agent-${Date.now()}`);
  const normalizedSelection = normalizeProfileSelection(selectedUserDataDir, options.profileDirectory);
  const detectedProfileDirectory =
    normalizedSelection.profileDirectory || detectLastUsedProfile(normalizedSelection.userDataDir);

  return {
    userDataDir: normalizedSelection.userDataDir,
    profileDirectory: detectedProfileDirectory,
    isEphemeral: !options.userDataDir && normalizedSelection.userDataDir.startsWith(tmpdir()),
    usingSystemProfile: !options.userDataDir && !!defaultUserDataDir && normalizedSelection.userDataDir === defaultUserDataDir,
  };
}

/** Wait for DevToolsActivePort file to appear after Chrome launches */
async function waitForDevToolsPort(userDataDir: string, timeout = 15000): Promise<string> {
  const portFile = join(userDataDir, 'DevToolsActivePort');
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (existsSync(portFile)) {
      const content = readFileSync(portFile, 'utf-8').trim();
      const lines = content.split('\n');
      if (lines.length >= 2) {
        const port = lines[0].trim();
        const path = lines[1].trim();
        return `ws://127.0.0.1:${port}${path}`;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for DevToolsActivePort (${timeout}ms)`);
}

export interface BrowserInstance {
  connection: CDPConnection;
  process?: ChildProcess;
  wsEndpoint: string;
  close(): Promise<void>;
}

/**
 * Launch a new Chrome process with stealth flags, or connect to an existing one.
 */
export async function launchBrowser(
  options: BrowserLaunchOptions,
  stealth: StealthConfig,
): Promise<BrowserInstance> {
  // Mode A: Connect to user's real Chrome (relaunch with debug port if needed)
  if (options.useRealChrome) {
    return connectToRealChrome(options, stealth);
  }

  // Mode B: Connect to explicit WebSocket endpoint
  if (options.wsEndpoint) {
    return connectToExisting(options, stealth);
  }

  // Mode C: Launch new process
  const installation = resolveChromeInstallation(options.executablePath);
  const execPath = installation.executablePath;
  const { userDataDir, profileDirectory, isEphemeral, usingSystemProfile } = resolveLaunchProfile(
    options,
    installation.defaultUserDataDir,
  );

  mkdirSync(userDataDir, { recursive: true });

  const launchOptions = { ...options, userDataDir, profileDirectory };
  const args = buildChromeArgs(launchOptions);

  logger.info('Launcher', `Starting Chrome: ${execPath}`);
  logger.info(
    'Launcher',
    usingSystemProfile
      ? `Using existing Chrome profile: ${userDataDir}${profileDirectory ? ` (${profileDirectory})` : ''}`
      : `Using browser profile dir: ${userDataDir}${profileDirectory ? ` (${profileDirectory})` : ''}`,
  );
  logger.debug('Launcher', `Args: ${args.join(' ')}`);

  const proc = spawn(execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) logger.debug('Chrome', line);
  });

  proc.on('exit', (code) => {
    logger.info('Launcher', `Chrome exited with code ${code}`);
  });

  // Wait for debugger endpoint
  let wsUrl: string;
  try {
    wsUrl = await waitForDevToolsPort(userDataDir);
  } catch (error) {
    if (usingSystemProfile) {
      throw new Error(
        `Failed to open the existing Chrome profile at ${userDataDir}. Close other Chrome instances using that profile or connect to a running browser with --ws-endpoint. ${(error as Error).message}`,
      );
    }
    throw error;
  }
  logger.info('Launcher', `DevTools WebSocket: ${wsUrl}`);

  const transport = await WebSocketTransport.connect(wsUrl);
  const connection = new CDPConnection(transport);

  // Apply stealth to browser-level session
  await applyBrowserStealth(connection, stealth, options);

  return {
    connection,
    process: proc,
    wsEndpoint: wsUrl,
    async close() {
      connection.close();
      if (proc && !proc.killed) {
        proc.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          proc.on('exit', resolve);
          setTimeout(() => {
            if (!proc.killed) proc.kill('SIGKILL');
            resolve();
          }, 5000);
        });
      }
      if (isEphemeral && existsSync(userDataDir)) {
        try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
      }
    },
  };
}

// ─── Real Chrome Mode ────────────────────────────────────────

/**
 * Create a wrapper directory for Chrome's user-data-dir that symlinks all
 * contents back to the real profile directory. This tricks Chrome into accepting
 * the directory as "non-default" while using the real profile data.
 */
function createProfileWrapper(realDir: string, wrapperDir: string): string {
  // Clean up if wrapper already exists
  if (existsSync(wrapperDir)) {
    try {
      const stat = lstatSync(wrapperDir);
      if (stat.isSymbolicLink()) {
        rmSync(wrapperDir);
      } else {
        rmSync(wrapperDir, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  }

  mkdirSync(wrapperDir, { recursive: true });

  // Entries that must NOT be symlinked — Chrome uses them for process locking
  const SKIP_ENTRIES = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']);

  const entries = readdirSync(realDir);
  for (const entry of entries) {
    if (SKIP_ENTRIES.has(entry)) continue;
    const realPath = join(realDir, entry);
    const wrapperPath = join(wrapperDir, entry);
    try {
      symlinkSync(realPath, wrapperPath);
    } catch (e) {
      logger.debug('RealChrome', `Could not symlink ${entry}: ${(e as Error).message}`);
    }
  }

  return wrapperDir;
}

/** Fetch Chrome's /json/version endpoint to get the DevTools WebSocket URL */
async function fetchDebugEndpoint(port: number, timeout = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const data = JSON.parse(body) as { webSocketDebuggerUrl?: string };
          resolve(data.webSocketDebuggerUrl ?? null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

/** Wait for Chrome's debugging port to become available after relaunch */
async function waitForDebugEndpoint(port: number, timeout = 20000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const wsUrl = await fetchDebugEndpoint(port, 2000);
    if (wsUrl) return wsUrl;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for Chrome debugging port ${port} (${timeout}ms)`);
}

/** Check if the user's Chrome (not Playwright/puppeteer) is running */
function isChromeRunning(): boolean {
  try {
    // Match only the main Chrome binary, not child processes or Playwright instances
    const result = execSync(
      "ps -eo pid,user,args | grep -E '/opt/google/chrome/chrome|/usr/bin/google-chrome|/usr/bin/chromium' | grep -v grep | grep -v playwright | grep -v puppeteer | awk '{print $1}'",
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    return result.length > 0;
  } catch {
    return false;
  }
}

/** Gracefully close the user's Chrome (SIGTERM, then SIGKILL after timeout) */
async function closeExistingChrome(): Promise<void> {
  if (!isChromeRunning()) return;

  logger.info('RealChrome', 'Closing existing Chrome instance...');
  try {
    // Only kill the user's Chrome processes, not Playwright instances
    execSync(
      "ps -eo pid,user,args | grep -E '/opt/google/chrome/chrome|/usr/bin/google-chrome|/usr/bin/chromium' | grep -v grep | grep -v playwright | grep -v puppeteer | awk '{print $1}' | xargs -r kill -TERM 2>/dev/null",
      { stdio: 'pipe' },
    );
  } catch { /* ignore — process may not exist */ }

  // Wait up to 8 seconds for graceful exit
  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (!isChromeRunning()) {
      logger.info('RealChrome', 'Chrome closed gracefully');
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // Force kill if still running
  logger.warn('RealChrome', 'Chrome did not exit gracefully, force-killing...');
  try {
    execSync(
      "ps -eo pid,user,args | grep -E '/opt/google/chrome/chrome|/usr/bin/google-chrome|/usr/bin/chromium' | grep -v grep | grep -v playwright | grep -v puppeteer | awk '{print $1}' | xargs -r kill -9 2>/dev/null",
      { stdio: 'pipe' },
    );
  } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 1000));
}

/**
 * Connect to the user's real Chrome browser session.
 *
 * Strategy:
 * 1. Check if Chrome is already running with a debugging port — connect directly
 * 2. If not, close existing Chrome and relaunch it with --remote-debugging-port
 *    using the user's real profile (cookies, logins, extensions intact)
 * 3. Connect via the debugging WebSocket
 *
 * This avoids bot detection because:
 * - Uses the user's real Chrome profile with existing cookies and session data
 * - No --enable-automation flag
 * - No --disable-extensions (user's extensions load normally)
 * - Normal Chrome fingerprint (not a fresh/temp profile)
 */
async function connectToRealChrome(
  options: BrowserLaunchOptions,
  stealth: StealthConfig,
): Promise<BrowserInstance> {
  const port = options.remoteDebuggingPort ?? 9222;

  // Step 1: Try connecting to an already-debuggable Chrome
  logger.info('RealChrome', `Checking for Chrome debugging port on ${port}...`);
  let wsUrl = await fetchDebugEndpoint(port);

  if (wsUrl) {
    logger.info('RealChrome', `Found existing Chrome with debugging on port ${port}`);
  } else {
    // Step 2: Need to relaunch Chrome with debugging enabled
    logger.info('RealChrome', 'No debugging port found. Will relaunch Chrome with remote debugging enabled.');

    await closeExistingChrome();

    // Resolve the Chrome executable
    const installation = resolveChromeInstallation(options.executablePath);
    const execPath = installation.executablePath;

    // Resolve the user's REAL profile directory (not ephemeral!)
    const realUserDataDir = options.userDataDir
      ?? installation.defaultUserDataDir
      ?? join(homedir(), '.config/google-chrome');

    if (!existsSync(realUserDataDir)) {
      throw new Error(
        `Chrome user data directory not found: ${realUserDataDir}. ` +
        `Ensure Chrome has been used at least once, or specify --user-data-dir.`
      );
    }

    // Chrome refuses --remote-debugging-port when user-data-dir is the default path.
    // It resolves symlinks, so a simple symlink doesn't work.
    // Workaround: create a real wrapper directory and symlink each item inside it
    // to the corresponding item in the real profile dir. Chrome sees a "non-default"
    // directory path, but all profile data points back to the real data via symlinks.
    const chromeDefaultDir = installation.defaultUserDataDir ?? join(homedir(), '.config/google-chrome');
    let userDataDir = realUserDataDir;

    if (realUserDataDir === chromeDefaultDir) {
      const wrapperPath = join(tmpdir(), 'phantom-chrome-profile');
      userDataDir = createProfileWrapper(realUserDataDir, wrapperPath);
      logger.info('RealChrome', `Using wrapper dir ${wrapperPath} with symlinked contents from ${realUserDataDir}`);
    }

    const profileDir = options.profileDirectory ?? detectLastUsedProfile(realUserDataDir);

    // Build minimal args — keep Chrome as "normal" as possible
    // We intentionally avoid most automation flags to reduce bot fingerprint
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      // Keep the window size consistent
      `--window-size=${options.viewport.width},${options.viewport.height}`,
      // These are safe flags that don't affect fingerprinting
      '--no-first-run',
      '--no-default-browser-check',
    ];

    if (profileDir) {
      args.push(`--profile-directory=${profileDir}`);
    }

    // Do NOT add: --disable-extensions, --disable-sync, --disable-infobars, etc.
    // These would alter the fingerprint and potentially break the user's session

    logger.info('RealChrome', `Launching Chrome: ${execPath}`);
    logger.info('RealChrome', `Profile: ${realUserDataDir}${profileDir ? ` (${profileDir})` : ''}`);
    logger.info('RealChrome', `Debugging port: ${port}`);
    logger.debug('RealChrome', `Args: ${args.join(' ')}`);

    const proc = spawn(execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // Let Chrome survive if phantom-agent exits
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
    });

    // Unref so phantom-agent can exit without killing Chrome
    proc.unref();

    proc.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) logger.debug('Chrome', line);
    });

    // Wait for the debugging port to become available
    try {
      wsUrl = await waitForDebugEndpoint(port);
    } catch (error) {
      throw new Error(
        `Failed to start Chrome with debugging port. ${(error as Error).message}\n` +
        `This may happen if Chrome's profile is locked. Try closing all Chrome windows first.`
      );
    }
  }

  logger.info('RealChrome', `DevTools WebSocket: ${wsUrl}`);

  const transport = await WebSocketTransport.connect(wsUrl);
  const connection = new CDPConnection(transport);

  // Apply stealth — but with lighter touch for real Chrome mode
  // We still want CDP detection hiding, but skip user-agent override
  // since the real Chrome already has a legitimate UA
  await applyRealChromeStealthSetup(connection, stealth, options);

  return {
    connection,
    // No process reference — we don't own the Chrome process in real-chrome mode
    wsEndpoint: wsUrl,
    async close() {
      connection.close();
      // Intentionally do NOT kill Chrome — user's browser stays open
      logger.info('RealChrome', 'Disconnected from Chrome (browser stays open)');
    },
  };
}

/**
 * Lighter stealth setup for real Chrome mode.
 * We skip user-agent override (real Chrome has legitimate UA) and
 * skip most aggressive patches, but still:
 * - Enable target discovery and auto-attach for page injection
 * - Inject CDP detection hiding (navigator.webdriver, etc.)
 */
async function applyRealChromeStealthSetup(
  connection: CDPConnection,
  stealth: StealthConfig,
  options: BrowserLaunchOptions,
): Promise<void> {
  const root = connection.rootSession;

  // Discover existing targets
  await root.send('Target.setDiscoverTargets', { discover: true });

  // Do NOT override user-agent — the real Chrome's UA is legitimate and
  // matches other headers/fingerprint data. Overriding it would create
  // inconsistencies that bot detectors look for.

  // Auto-attach to new pages for stealth injection
  await root.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });

  // Handle new target sessions — inject minimal stealth then resume
  root.on('Target.attachedToTarget', async (params: any) => {
    const { sessionId, targetInfo } = params;
    if (targetInfo.type !== 'page') {
      const session = (connection as any).sessions?.get(sessionId);
      if (session) await session.sendMayFail('Runtime.runIfWaitingForDebugger');
      return;
    }

    try {
      const session = (connection as any).sessions?.get(sessionId);
      if (session) {
        // Still inject stealth scripts to hide CDP artifacts
        // (navigator.webdriver, Runtime.enable detection, etc.)
        await injectStealthScripts(session, stealth);
        await session.send('Runtime.runIfWaitingForDebugger');
      }
    } catch (e) {
      logger.warn('RealChrome', `Failed to inject stealth into session ${sessionId}: ${(e as Error).message}`);
    }
  });
}

// ─── Existing Connection Mode ────────────────────────────────

async function connectToExisting(
  options: BrowserLaunchOptions,
  stealth: StealthConfig,
): Promise<BrowserInstance> {
  const transport = await WebSocketTransport.connect(options.wsEndpoint!);
  const connection = new CDPConnection(transport);
  await applyBrowserStealth(connection, stealth, options);

  return {
    connection,
    wsEndpoint: options.wsEndpoint!,
    async close() {
      connection.close();
    },
  };
}

/** Apply stealth at browser level and set up auto-injection for new pages */
async function applyBrowserStealth(
  connection: CDPConnection,
  stealth: StealthConfig,
  options: BrowserLaunchOptions,
): Promise<void> {
  const root = connection.rootSession;

  // Discover existing targets
  await root.send('Target.setDiscoverTargets', { discover: true });

  // Set user agent override at browser level
  if (options.userAgent) {
    await root.sendMayFail('Network.setUserAgentOverride', {
      userAgent: options.userAgent,
      acceptLanguage: stealth.languages.join(','),
      platform: stealth.platform,
    });
  }

  // Listen for new targets and auto-attach
  await root.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });

  // Handle new target sessions — inject stealth and resume
  root.on('Target.attachedToTarget', async (params: any) => {
    const { sessionId, targetInfo } = params;
    if (targetInfo.type !== 'page') {
      // Resume non-page targets immediately
      const session = (connection as any).sessions?.get(sessionId);
      if (session) await session.sendMayFail('Runtime.runIfWaitingForDebugger');
      return;
    }

    // For page targets, inject stealth then resume
    try {
      const session = (connection as any).sessions?.get(sessionId);
      if (session) {
        await injectStealthScripts(session, stealth);
        await session.send('Runtime.runIfWaitingForDebugger');
      }
    } catch (e) {
      logger.warn('Stealth', `Failed to inject into session ${sessionId}: ${(e as Error).message}`);
    }
  });
}
