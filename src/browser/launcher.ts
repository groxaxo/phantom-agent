/**
 * Chrome process launcher with stealth-optimized flags.
 * Synthesized from playwright's chromiumSwitches + chrome-devtools-mcp's browser.ts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
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
  // Mode A: Connect to existing browser
  if (options.wsEndpoint) {
    return connectToExisting(options, stealth);
  }

  // Mode B: Launch new process
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
