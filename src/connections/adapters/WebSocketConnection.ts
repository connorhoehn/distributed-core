import { EventEmitter } from 'events';
import { ConnectionManager } from '../ConnectionManager';
import { MessageRouterFunction, SessionMetadata } from '../types';

// Mock WebSocket interface for testing
export interface MockWebSocket extends EventEmitter {
  send(data: string | Buffer): void;
  close(): void;
  readyState: number;
}

// Mock WebSocket Server interface
export interface MockWebSocketServer extends EventEmitter {
  on(event: 'connection', listener: (ws: MockWebSocket) => void): this;
}

/**
 * Binds a WebSocket server to a ConnectionManager
 * In production, you would import from 'ws' package
 * For testing, we use mock interfaces
 */
export class WebSocketAdapter {
  private connectionMap = new Map<string, MockWebSocket>();

  constructor(
    private manager: ConnectionManager,
    private routeFn?: MessageRouterFunction
  ) {}

  /**
   * Bind to a WebSocket server (or mock for testing)
   */
  bind(wss: MockWebSocketServer): void {
    wss.on('connection', (ws: MockWebSocket) => {
      this.handleConnection(ws);
    });
  }

  /**
   * Create a mock WebSocket connection for testing
   */
  createMockConnection(id?: string): { connectionId: string; mockWs: MockWebSocket } {
    const connectionId = id || this.generateConnectionId();
    const mockWs = new MockWebSocketEventEmitter();
    
    this.handleConnection(mockWs, connectionId);
    
    return { connectionId, mockWs };
  }

  private handleConnection(ws: MockWebSocket, id?: string): void {
    const connectionId = id || this.generateConnectionId();
    
    // Store WebSocket reference
    this.connectionMap.set(connectionId, ws);

    // Create connection with send function
    const conn = this.manager.createConnection(
      connectionId,
      (data) => {
        if (ws.readyState === 1) { // WebSocket.OPEN
          ws.send(data);
        }
      },
      this.extractMetadata(ws)
    );

    // Handle incoming messages
    ws.on('message', (data: Buffer | string) => {
      try {
        const message = JSON.parse(data.toString());
        conn.onMessageReceived(message);
        
        // Route message if router function provided
        if (this.routeFn) {
          this.routeFn(message, connectionId);
        }
      } catch (err) {
        conn.emit('error', new Error(`Invalid message format: ${err}`));
      }
    });

    // Handle pong responses (for heartbeat)
    ws.on('pong', () => {
      conn.markActivity();
    });

    // Handle WebSocket close
    ws.on('close', (code?: number, reason?: string) => {
      this.connectionMap.delete(connectionId);
      conn.close(`WebSocket closed: ${code} ${reason}`);
    });

    // Handle WebSocket errors
    ws.on('error', (error: Error) => {
      conn.emit('error', error);
    });

    // Handle connection errors
    conn.on('error', (error: Error) => {
      console.warn(`Connection ${connectionId} error:`, error);
    });
  }

  private generateConnectionId(): string {
    return `ws-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private extractMetadata(ws: MockWebSocket): SessionMetadata {
    // In production, you might extract metadata from headers, query params, etc.
    // For now, return basic metadata
    return {
      connectedAt: Date.now(),
      transport: 'websocket'
    };
  }

  getWebSocket(connectionId: string): MockWebSocket | undefined {
    return this.connectionMap.get(connectionId);
  }

  getActiveConnections(): string[] {
    return Array.from(this.connectionMap.keys());
  }
}

/**
 * Mock WebSocket implementation for testing
 */
class MockWebSocketEventEmitter extends EventEmitter implements MockWebSocket {
  public readyState = 1; // WebSocket.OPEN

  send(data: string | Buffer): void {
    // Simulate async send
    process.nextTick(() => {
      this.emit('sent', data);
    });
  }

  close(): void {
    this.readyState = 3; // WebSocket.CLOSED
    this.emit('close');
  }

  // Simulate receiving a message
  simulateMessage(data: any): void {
    const message = typeof data === 'string' ? data : JSON.stringify(data);
    this.emit('message', Buffer.from(message));
  }

  // Simulate pong response
  simulatePong(): void {
    this.emit('pong');
  }
}
