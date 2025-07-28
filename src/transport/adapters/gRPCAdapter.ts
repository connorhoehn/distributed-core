import { Transport } from '../Transport';
import { NodeId, Message } from '../../types';

/**
 * gRPC transport adapter for typed streaming communication
 * Supports bi-directional streaming and strong contracts via Protobuf
 */
export class gRPCAdapter extends Transport {
  private nodeId: NodeId;
  private server: any; // grpc.Server (stub)
  private clients = new Map<string, any>(); // gRPC clients
  private streams = new Map<string, any>(); // Active streams
  private isStarted = false;
  private static adapterRegistry = new Map<string, gRPCAdapter>();

  constructor(nodeId: NodeId, private port: number = 50051) {
    super();
    this.nodeId = nodeId;
  }

  async start(): Promise<void> {
    if (this.isStarted) return;

    gRPCAdapter.adapterRegistry.set(this.nodeId.id, this);
    this.isStarted = true;
    this.emit('started');
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;

    // Close all streams
    for (const [id, stream] of this.streams) {
      // stream.end();
    }
    this.streams.clear();

    // Close all clients
    for (const [id, client] of this.clients) {
      // client.close();
    }
    this.clients.clear();

    // Stop server
    if (this.server) {
      // this.server.forceShutdown();
      this.server = null;
    }

    gRPCAdapter.adapterRegistry.delete(this.nodeId.id);
    this.isStarted = false;
    this.emit('stopped');
  }

  async send(message: Message, target: NodeId): Promise<void> {
    if (!this.isStarted) {
      throw new Error('gRPC server not started');
    }

    let client = this.clients.get(target.id);
    if (!client) {
      throw new Error(`No gRPC client for node ${target.id}`);
    }

    // Simulate message delivery to target adapter
    const targetAdapter = gRPCAdapter.adapterRegistry?.get(target.id);
    if (targetAdapter) {
      setTimeout(() => {
        targetAdapter.emit('message', message);
      }, 1);
    }

    return Promise.resolve();
  }

  async createStream(target: NodeId): Promise<string> {
    if (!this.isStarted) {
      throw new Error('Adapter not started');
    }

    let client = this.clients.get(target.id);
    if (!client) {
      await this.createClient(target);
      client = this.clients.get(target.id);
    }

    // Stub: In real implementation would create bidirectional stream
    // const stream = client.streamMessages();
    // const streamId = `${target.id}-${Date.now()}`;
    // this.streams.set(streamId, stream);
    // 
    // stream.on('data', (message) => {
    //   this.emit('message', message);
    // });
    // 
    // stream.on('error', (error) => {
    //   this.emit('error', error);
    //   this.streams.delete(streamId);
    // });

    const streamId = `${target.id}-${Date.now()}`;
    const mockStream = {
      id: streamId,
      target: target.id,
      active: true,
      write: (data: any) => console.log(`Mock gRPC stream write to ${target.id}:`, data),
      end: () => console.log(`Mock gRPC stream ended to ${target.id}`)
    };
    this.streams.set(streamId, mockStream);

    return streamId;
  }

  closeStream(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (stream) {
      // stream.end();
      this.streams.delete(streamId);
    }
  }

  async sendToStream(streamId: string, message: Message): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new Error(`Stream ${streamId} not found`);
    }

    // stream.write(message);
    return Promise.resolve();
  }

  getActiveStreams(): string[] {
    return Array.from(this.streams.keys());
  }

  isStreamActive(streamId: string): boolean {
    const stream = this.streams.get(streamId);
    return stream && stream.active;
  }

  private async createClient(target: NodeId): Promise<void> {
    // Stub: In real implementation would create gRPC client
    // const grpc = require('@grpc/grpc-js');
    // const protoLoader = require('@grpc/proto-loader');
    // 
    // const packageDefinition = protoLoader.loadSync('gossip.proto');
    // const proto = grpc.loadPackageDefinition(packageDefinition);
    // 
    // const client = new proto.GossipService(
    //   `${target.address}:${target.port}`,
    //   grpc.credentials.createInsecure()
    // );

    const mockClient = {
      id: target.id,
      target,
      sendMessage: (message: Message, callback: Function) => {
        // Mock successful send
        setTimeout(() => callback(null, { status: 'OK' }), 5);
      },
      streamMessages: () => ({
        write: (data: any) => console.log(`Mock gRPC send to ${target.id}:`, data),
        end: () => console.log(`Mock gRPC client ended to ${target.id}`)
      }),
      close: () => console.log(`Mock gRPC client closed to ${target.id}`)
    };

    this.clients.set(target.id, mockClient);
  }

  /**
   * Handle incoming gRPC message (stub)
   */
  private handleMessage(call: any, callback: Function): void {
    // Stub: In real implementation would process incoming message
    // const message = call.request;
    // this.emit('message', message);
    // callback(null, { status: 'received' });
  }

  /**
   * Handle incoming gRPC stream (stub)
   */
  private handleStream(call: any): void {
    // Stub: In real implementation would handle bidirectional stream
    // call.on('data', (message) => {
    //   this.emit('message', message);
    // });
  }

  async connect(target: NodeId): Promise<void> {
    if (!this.isStarted) {
      throw new Error('Adapter not started');
    }

    if (!this.clients.has(target.id)) {
      await this.createClient(target);
      this.emit('connected', target);
    }
  }

  async disconnect(target: NodeId): Promise<void> {
    const client = this.clients.get(target.id);
    if (client) {
      client.close();
      this.clients.delete(target.id);
      this.emit('disconnected', target);
    }
  }

  createBidirectionalStream(target: NodeId): any {
    const client = this.clients.get(target.id);
    if (!client) {
      throw new Error(`No gRPC client for node ${target.id}`);
    }

    const streamId = `${target.id}-${Date.now()}`;
    const mockStream = {
      id: streamId,
      write: (data: any) => {
        // Simulate stream write
        setTimeout(() => {
          this.emit('data', data);
        }, 1);
      },
      end: () => {
        this.streams.delete(streamId);
        setTimeout(() => {
          this.emit('end');
        }, 1);
      },
      on: (event: string, handler: (...args: any[]) => void) => {
        // Mock event handling
        if (event === 'data' || event === 'end' || event === 'error') {
          this.on(event, handler);
        }
      }
    };

    this.streams.set(streamId, { ...mockStream, active: true });
    return mockStream;
  }

  getServiceMethods(): string[] {
    return ['sendMessage', 'createStream'];
  }

  isConnected(target: NodeId): boolean {
    return this.clients.has(target.id);
  }

  onMessage(callback: (message: Message) => void): void {
    this.on('message', callback);
  }

  removeMessageListener(callback: (message: Message) => void): void {
    this.removeListener('message', callback);
  }

  getConnectedNodes(): NodeId[] {
    return Array.from(this.clients.values()).map(client => client.target);
  }
}
