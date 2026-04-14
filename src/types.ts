// Unified types for the phantom-agent system

// ─── CDP Protocol Types ──────────────────────────────────────

export interface ProtocolRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface ProtocolResponse {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  sessionId?: string;
}

// ─── Browser Types ───────────────────────────────────────────

export interface BrowserLaunchOptions {
  headless: boolean;
  executablePath?: string;
  userDataDir?: string;
  profileDirectory?: string;
  viewport: { width: number; height: number };
  args?: string[];
  wsEndpoint?: string;
  userAgent?: string;
  timezone?: string;
  locale?: string;
}

export interface StealthConfig {
  userAgent: string;
  platform: string;
  vendor: string;
  languages: string[];
  webglVendor: string;
  webglRenderer: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  maxTouchPoints: number;
  timezone: string;
  locale: string;
}

// ─── DOM Types ───────────────────────────────────────────────

export interface DomNode {
  nodeId: string;
  tagName: string;
  attributes: Record<string, string>;
  children: string[];
  textContent: string;
  isInteractive: boolean;
  isVisible: boolean;
  isInViewport: boolean;
  highlightIndex?: number;
  boundingBox?: { x: number; y: number; width: number; height: number };
  xpath: string;
}

export interface FlatDomTree {
  rootId: string;
  map: Record<string, DomNode>;
}

export interface BrowserState {
  url: string;
  title: string;
  header: string;
  content: string;
  footer: string;
  screenshot?: string; // base64
}

// ─── Input Types ─────────────────────────────────────────────

export type MouseButton = 'left' | 'right' | 'middle' | 'none';
export type KeyboardModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

export interface KeyDescription {
  key: string;
  code: string;
  keyCode: number;
  keyCodeWithoutLocation: number;
  text: string;
  location: number;
}

// ─── Agent Types ─────────────────────────────────────────────

export type AgentStatus = 'idle' | 'running' | 'completed' | 'error';

export interface AgentConfig {
  llm: LLMConfig;
  browser: BrowserLaunchOptions;
  stealth: StealthConfig;
  maxSteps: number;
  stepDelayMs: number;
  enableVision: boolean;
  language: 'en-US' | 'zh-CN';
  customSystemPrompt?: string;
  instructions?: {
    system?: string;
    getPageInstructions?: (url: string) => string | undefined;
  };
}

export interface LLMConfig {
  baseURL: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxRetries: number;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | MessageContent[];
}

export interface MessageContent {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: string };
}

export interface ToolDefinition<TInput = unknown> {
  description: string;
  parameters: Record<string, unknown>;
  execute: (input: TInput, ctx: ToolContext) => Promise<string>;
}

export interface ToolContext {
  pageController: PageControllerInterface;
  onAskUser?: (question: string) => Promise<string>;
}

export interface PageControllerInterface {
  getBrowserState(): Promise<BrowserState>;
  clickElement(index: number): Promise<{ message: string }>;
  inputText(index: number, text: string): Promise<{ message: string }>;
  selectOption(index: number, text: string): Promise<{ message: string }>;
  scroll(opts: ScrollOptions): Promise<{ message: string }>;
  scrollHorizontally(opts: HScrollOptions): Promise<{ message: string }>;
  executeJavascript(script: string): Promise<{ message: string }>;
  takeScreenshot(): Promise<string>;
  getLastUpdateTime?(): number;
}

export interface ScrollOptions {
  down: boolean;
  numPages?: number;
  pixels?: number;
  index?: number;
}

export interface HScrollOptions {
  right: boolean;
  pixels: number;
  index?: number;
}

// ─── Agent History Types ─────────────────────────────────────

export interface AgentReflection {
  evaluation_previous_goal?: string;
  memory?: string;
  next_goal?: string;
}

export interface AgentStepEvent {
  type: 'step';
  stepIndex: number;
  reflection: AgentReflection;
  action: {
    name: string;
    input: unknown;
    output: string;
  };
  usage?: TokenUsage;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

export type HistoricalEvent =
  | AgentStepEvent
  | { type: 'observation'; content: string }
  | { type: 'error'; message: string }
  | { type: 'retry'; message: string; attempt: number; maxAttempts: number };

export interface MacroToolInput {
  evaluation_previous_goal?: string;
  memory?: string;
  next_goal?: string;
  action: Record<string, unknown>;
}

export interface MacroToolResult {
  input: MacroToolInput;
  output: string;
}

export interface ExecutionResult {
  success: boolean;
  data: string;
  history: HistoricalEvent[];
}

export interface InvokeResult {
  toolCall: { name: string; args: unknown };
  toolResult: unknown;
  usage: TokenUsage;
  rawResponse: unknown;
  rawRequest: unknown;
}
