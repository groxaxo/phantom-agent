/**
 * CDP Session management.
 * Synthesized from playwright's CRSession — manages request/response lifecycle
 * and event routing over a single CDP session.
 */
import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import type { ProtocolResponse } from '../types.js';

export class ProtocolError extends Error {
  type: 'closed' | 'crashed' | 'error';
  constructor(type: 'closed' | 'crashed' | 'error', method?: string, message?: string) {
    super(message ?? `Protocol error (${type})${method ? ` calling ${method}` : ''}`);
    this.type = type;
    this.name = 'ProtocolError';
  }
}

interface PendingCallback {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

export class CDPSession extends EventEmitter {
  readonly sessionId: string;
  private connection: CDPConnection;
  private callbacks = new Map<number, PendingCallback>();
  private closed = false;

  constructor(connection: CDPConnection, sessionId: string) {
    super();
    this.setMaxListeners(0);
    this.connection = connection;
    this.sessionId = sessionId;
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.closed) throw new ProtocolError('closed', method);

    const id = this.connection.rawSend(this.sessionId, method, params);
    return new Promise<T>((resolve, reject) => {
      this.callbacks.set(id, { resolve: resolve as (r: unknown) => void, reject, method });
    });
  }

  sendMayFail(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.send(method, params).catch((e) => {
      logger.debug('CDPSession', `${method} failed (ignored): ${(e as Error).message}`);
    });
  }

  onMessage(message: ProtocolResponse) {
    if (message.id !== undefined && this.callbacks.has(message.id)) {
      const cb = this.callbacks.get(message.id)!;
      this.callbacks.delete(message.id);
      if (message.error) {
        cb.reject(new ProtocolError('error', cb.method, message.error.message));
      } else {
        cb.resolve(message.result);
      }
    } else if (message.method) {
      this.emit(message.method, message.params);
    }
  }

  dispose() {
    this.closed = true;
    for (const cb of this.callbacks.values()) {
      cb.reject(new ProtocolError('closed', cb.method, 'Session disposed'));
    }
    this.callbacks.clear();
    this.removeAllListeners();
  }
}

/**
 * CDP Connection — manages the root WebSocket session and child sessions.
 * Synthesized from playwright's CRConnection pattern.
 */
import type { ConnectionTransport } from './transport.js';
import type { ProtocolRequest } from '../types.js';

export class CDPConnection extends EventEmitter {
  private lastId = 0;
  private transport: ConnectionTransport;
  private sessions = new Map<string, CDPSession>();
  readonly rootSession: CDPSession;
  private closed = false;

  constructor(transport: ConnectionTransport) {
    super();
    this.setMaxListeners(0);
    this.transport = transport;
    this.rootSession = new CDPSession(this, '');
    this.sessions.set('', this.rootSession);

    this.transport.onmessage = (msg) => this.onMessage(msg);
    this.transport.onclose = (reason) => this.onClose(reason);
  }

  rawSend(sessionId: string, method: string, params?: Record<string, unknown>): number {
    const id = ++this.lastId;
    const message: ProtocolRequest = { id, method, params };
    if (sessionId) (message as any).sessionId = sessionId;
    this.transport.send(message);
    return id;
  }

  private onMessage(message: ProtocolResponse) {
    const sessionId = (message as any).sessionId || '';
    const session = this.sessions.get(sessionId);
    if (session) {
      session.onMessage(message);
    }
  }

  private onClose(reason?: string) {
    this.closed = true;
    this.rootSession.dispose();
    for (const [id, session] of this.sessions) {
      if (id !== '') session.dispose();
    }
    this.sessions.clear();
    this.sessions.set('', this.rootSession);
    this.emit('disconnected', reason);
  }

  async createSession(targetId: string): Promise<CDPSession> {
    const result = await this.rootSession.send<{ sessionId: string }>(
      'Target.attachToTarget',
      { targetId, flatten: true },
    );
    const session = new CDPSession(this, result.sessionId);
    this.sessions.set(result.sessionId, session);

    // Listen for detach
    this.rootSession.on('Target.detachedFromTarget', (params: any) => {
      if (params.sessionId === result.sessionId) {
        session.dispose();
        this.sessions.delete(result.sessionId);
      }
    });

    return session;
  }

  get isConnected(): boolean {
    return !this.closed;
  }

  close() {
    if (!this.closed) this.transport.close();
  }
}
