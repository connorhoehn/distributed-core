import { Transport } from '../Transport';
import { NodeId, Message } from '../../types';

/**
 * WebSocket transport adapter for real-time bi-directional communication
 * Suitable for browser and Node.js environments
 */
export class WebSocketAdapter extends Transport {
  private nodeId: NodeId;
  private server: any; // WebSocket.Server (stub)
  private connections = new Map<string, any>(); // WebSocket connections
  private isStarted = false;
  private static adapterRegistry = new Map<string, WebSocketAdapter>();

  constructor(nodeId: NodeId, private port: number = 8080) {
    super();
    this.nodeId = nodeId;
  }

  async start(): Promise<void> {
    if (this.isStarted) return;

    // Stub: In real implementation, would use 'ws' library
    // const WebSocket = require('ws');
    // this.server = new WebSocket.Server({ port: this.port });
    
    WebSocketAdapter.adapterRegistry.set(this.nodeId.id, this);
    this.isStarted = true;
    this.emit('started');
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;

    // Close all connections
    for (const [nodeId, ws] of this.connections) {
      // ws.close();
    }
    this.connections.clear();

    // Close server
    if (this.server) {
      // this.server.close();
      this.server = null;
    }

    WebSocketAdapter.adapterRegistry.delete(this.nodeId.id);
    this.isStarted = false;
    this.emit('stopped');
  }

  async send(message: Message, target: NodeId): Promise<void> {
    if (!this.isStarted) {
      throw new Error('WebSocket server not started');
    }

    const connection = this.connections.get(target.id);
    if (!connection) {
      throw new Error(`Not connected to node ${target.id}`);
    }

    // Simulate message delivery to target adapter
    const targetAdapter = WebSocketAdapter.adapterRegistry.get(target.id);
    if (targetAdapter) {
      setTimeout(() => {
        targetAdapter.emit('message', message);
      }, 1);
    }
    
    return Promise.resolve();
  }

  async connect(target: NodeId): Promise<void> {
    if (!this.isStarted) {
      throw new Error('Adapter not started');
    }

    // Stub: In real implementation would create WebSocket connection
    // const ws = new WebSocket(`ws://${target.address}:${target.port}`);
    // this.connections.set(target.id, ws);
    
    // Simulate connection
    const mockConnection = { 
      id: target.id, 
      readyState: 1, // WebSocket.OPEN
      send: (data: string) => console.log(`Mock send to ${target.id}:`, data)
    };
    this.connections.set(target.id, mockConnection);
    this.emit('connected', target);
  }

  disconnect(target: NodeId): void {
    const connection = this.connections.get(target.id);
    if (connection) {
      // connection.close();
      this.connections.delete(target.id);
      this.emit('disconnected', target);
    }
  }

  getConnectedNodes(): NodeId[] {
    return Array.from(this.connections.keys()).map(id => ({
      id,
      address: 'localhost', // Stub
      port: this.port
    }));
  }

  isConnected(target: NodeId): boolean {
    const connection = this.connections.get(target.id);
    return connection && connection.readyState === 1; // WebSocket.OPEN
  }

  onMessage(callback: (message: Message) => void): void {
    this.on('message', callback);
  }

  removeMessageListener(callback: (message: Message) => void): void {
    this.removeListener('message', callback);
  }
}
