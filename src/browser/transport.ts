/**
 * WebSocket transport for Chrome DevTools Protocol.
 * Synthesized from playwright's ConnectionTransport pattern.
 */
import WebSocket from 'ws';
import { logger } from '../utils/logger.js';
import type { ProtocolRequest, ProtocolResponse } from '../types.js';

export interface ConnectionTransport {
  send(message: ProtocolRequest): void;
  close(): void;
  onmessage?: (message: ProtocolResponse) => void;
  onclose?: (reason?: string) => void;
}

export class WebSocketTransport implements ConnectionTransport {
  private ws: WebSocket;
  onmessage?: (message: ProtocolResponse) => void;
  onclose?: (reason?: string) => void;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as ProtocolResponse;
        this.onmessage?.(msg);
      } catch (e) {
        logger.error('Transport', 'Failed to parse CDP message', e);
      }
    });
    this.ws.on('close', (code, reason) => {
      this.onclose?.(reason?.toString() || `code=${code}`);
    });
    this.ws.on('error', (err) => {
      logger.error('Transport', 'WebSocket error', err.message);
    });
  }

  static async connect(url: string, headers?: Record<string, string>): Promise<WebSocketTransport> {
    return new Promise((resolve, reject) => {
      logger.info('Transport', `Connecting to ${url}`);
      const ws = new WebSocket(url, [], {
        perMessageDeflate: false,
        maxPayload: 256 * 1024 * 1024, // 256MB
        followRedirects: true,
        headers: {
          'User-Agent': 'PhantomAgent/1.0',
          ...headers,
        },
      });
      ws.on('open', () => {
        logger.info('Transport', 'Connected');
        resolve(new WebSocketTransport(ws));
      });
      ws.on('error', reject);
    });
  }

  send(message: ProtocolRequest): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('Transport', 'Attempted send on closed socket');
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.ws.close();
  }
}
