import { Transport } from '../Transport';
import { NodeId, Message } from '../../types';

/**
 * TCP transport adapter for reliable, persistent connections
 * Ideal for internal service-to-service communication
 */
export class TCPAdapter extends Transport {
  private nodeId: NodeId;
  private server: any; // net.Server (stub)
  private connections = new Map<string, any>(); // Socket connections
  private isStarted = false;
  private static adapterRegistry = new Map<string, TCPAdapter>();

  constructor(nodeId: NodeId, private port: number = 9090) {
    super();
    this.nodeId = nodeId;
  }

  async start(): Promise<void> {
    if (this.isStarted) return;

    // Stub: In real implementation, would use Node.js 'net' module
    // const net = require('net');
    // this.server = net.createServer((socket) => {
    //   this.handleConnection(socket);
    // });
    // this.server.listen(this.port);

    TCPAdapter.adapterRegistry.set(this.nodeId.id, this);
    this.isStarted = true;
    this.emit('started');
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;

    // Close all connections
    for (const [nodeId, socket] of this.connections) {
      // socket.destroy();
    }
    this.connections.clear();

    // Close server
    if (this.server) {
      // this.server.close();
      this.server = null;
    }

    TCPAdapter.adapterRegistry.delete(this.nodeId.id);
    this.isStarted = false;
    this.emit('stopped');
  }

  async send(message: Message, target: NodeId): Promise<void> {
    if (!this.isStarted) {
      throw new Error('TCP server not started');
    }

    let socket = this.connections.get(target.id);
    if (!socket) {
      await this.connect(target);
      socket = this.connections.get(target.id);
    }

    if (!socket) {
      throw new Error(`Failed to establish TCP connection to ${target.id}`);
    }

    // Simulate message delivery to target adapter
    const targetAdapter = TCPAdapter.adapterRegistry.get(target.id);
    if (targetAdapter) {
      setTimeout(() => {
        targetAdapter.emit('message', message);
      }, 1);
    }

    // Stub: In real implementation would serialize and write to socket
    // const data = JSON.stringify(message) + '\n';
    // socket.write(data);
    
    return Promise.resolve();
  }

  async connect(target: NodeId): Promise<void> {
    if (!this.isStarted) {
      throw new Error('Adapter not started');
    }

    // Stub: In real implementation would create TCP socket
    // const net = require('net');
    // const socket = new net.Socket();
    // await new Promise((resolve, reject) => {
    //   socket.connect(target.port, target.address, resolve);
    //   socket.on('error', reject);
    // });

    // Simulate connection
    const mockSocket = {
      id: target.id,
      connected: true,
      write: (data: string) => console.log(`Mock TCP send to ${target.id}:`, data),
      destroy: () => console.log(`Mock TCP disconnect from ${target.id}`)
    };
    this.connections.set(target.id, mockSocket);
    this.emit('connected', target);
  }

  disconnect(target: NodeId): void {
    const socket = this.connections.get(target.id);
    if (socket) {
      // socket.destroy();
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
    return this.connections.has(target.id);
  }

  onMessage(callback: (message: Message) => void): void {
    this.on('message', callback);
  }

  removeMessageListener(callback: (message: Message) => void): void {
    this.removeListener('message', callback);
  }

  /**
   * Handle incoming TCP connection (stub)
   */
  private handleConnection(socket: any): void {
    // Stub: In real implementation would handle incoming data
    // socket.on('data', (data) => {
    //   const message = JSON.parse(data.toString());
    //   this.emit('message', message);
    // });
  }
}
