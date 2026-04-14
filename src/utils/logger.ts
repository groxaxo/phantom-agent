const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

let currentLevel: Level = parseEnvLevel(process.env.LOG_LEVEL);
let writer: (...args: unknown[]) => void = (...args: unknown[]) => console.log(...args);

function parseEnvLevel(value: string | undefined): Level {
  if (!value) return 'info';
  const normalized = value.toLowerCase();
  return normalized in LEVELS ? (normalized as Level) : 'info';
}

export function setLogLevel(level: Level) {
  currentLevel = level;
}

export function setLogDestination(destination: 'stdout' | 'stderr') {
  writer = destination === 'stderr'
    ? (...args: unknown[]) => console.error(...args)
    : (...args: unknown[]) => console.log(...args);
}

function log(level: Level, tag: string, ...args: unknown[]) {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const ts = new Date().toISOString().slice(11, 23);
  const color = COLORS[level];
  const prefix = `${color}${ts} [${level.toUpperCase().padEnd(5)}]${RESET} ${BOLD}${tag}${RESET}`;
  writer(prefix, ...args);
}

export const logger = {
  debug: (tag: string, ...args: unknown[]) => log('debug', tag, ...args),
  info: (tag: string, ...args: unknown[]) => log('info', tag, ...args),
  warn: (tag: string, ...args: unknown[]) => log('warn', tag, ...args),
  error: (tag: string, ...args: unknown[]) => log('error', tag, ...args),
};
