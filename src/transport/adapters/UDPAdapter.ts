import * as dgram from 'dgram';
import { Transport } from '../Transport';
import { NodeId, Message } from '../../types';
import { CircuitBreaker } from '../CircuitBreaker';
import { RetryManager, RetryOptions } from '../RetryManager';

interface UDPConnection {
  nodeId: NodeId;
  lastActivity: number;
  packetsSent: number;
  packetsReceived: number;
  isReachable: boolean;
}

interface UDPAdapterOptions {
  port?: number;
  host?: string;
  multicastAddress?: string;
  multicastPort?: number;
  enableMulticast?: boolean;
  maxPacketSize?: number;
  timeout?: number;
  enableBroadcast?: boolean;
  enableLogging?: boolean;
  retryConfig?: Partial<RetryOptions>;
}

/**
 * UDP transport adapter for high-throughput, low-latency communication
 * Perfect for real-time data, heartbeats, and high-volume messaging
 */
export class UDPAdapter extends Transport {
  private readonly nodeId: NodeId;
  private readonly options: Required<UDPAdapterOptions>;
  private socket?: dgram.Socket;
  private multicastSocket?: dgram.Socket;
  private connections = new Map<string, UDPConnection>();
  private isStarted = false;
  private circuitBreaker: CircuitBreaker;
  private retryManager: RetryManager;
  private messageHandlers: Set<(message: Message) => void> = new Set();

  private static readonly MAX_UDP_PACKET_SIZE = 65507; // Max UDP payload size

  constructor(nodeId: NodeId, options: UDPAdapterOptions = {}) {
    super();
    this.nodeId = nodeId;
    this.options = {
      port: options.port || 8080,
      host: options.host || '0.0.0.0',
      maxPacketSize: options.maxPacketSize || 65507,
      timeout: options.timeout || 5000,
      enableBroadcast: options.enableBroadcast || false,
      enableMulticast: options.enableMulticast || false,
      multicastAddress: options.multicastAddress || '224.0.0.1',
      multicastPort: options.multicastPort || 8081,
      enableLogging: options.enableLogging !== false
    } as Required<UDPAdapterOptions>;
    
    this.circuitBreaker = new CircuitBreaker({
      enableLogging: this.options.enableLogging,
      name: `udp-circuit-breaker-${nodeId.id}`
    });
    this.retryManager = new RetryManager({
      enableLogging: this.options.enableLogging,
      name: `udp-retry-manager-${nodeId.id}`,
      ...options.retryConfig
    });
  }

  getLocalNodeInfo(): NodeId {
    return this.nodeId;
  }

  async start(): Promise<void> {
    if (this.isStarted) return;

    try {
      await this.circuitBreaker.execute(async () => {
        // Create main UDP socket
        this.socket = dgram.createSocket('udp4');
        this.socket.unref(); // Prevent Jest hanging
        
        this.socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo));
        this.socket.on('error', (error) => this.handleSocketError(error));
        this.socket.on('listening', () => {
          const address = this.socket!.address();
          this.log(`UDP socket listening on ${address.address}:${address.port}`);
        });

        // Bind socket first
        await new Promise<void>((resolve, reject) => {
          this.socket!.on('error', reject);
          this.socket!.bind(this.options.port, this.options.host, () => {
            // Enable broadcast after binding if configured
            if (this.options.enableBroadcast) {
              try {
                this.socket!.setBroadcast(true);
              } catch (error) {
                this.log(`Warning: Could not enable broadcast: ${error}`);
              }
            }
            resolve();
          });
        });

        // Setup multicast if enabled
        if (this.options.enableMulticast) {
          await this.setupMulticast();
        }

        this.isStarted = true;
        this.emit('started', { 
          port: this.options.port, 
          host: this.options.host,
          multicast: this.options.enableMulticast,
          multicastAddress: this.options.multicastAddress
        });
      });
    } catch (error) {
      this.emit('start-error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;

    try {
      // Close multicast socket
      if (this.multicastSocket) {
        await new Promise<void>((resolve) => {
          this.multicastSocket!.close(() => resolve());
        });
        this.multicastSocket = undefined;
      }

      // Close main socket
      if (this.socket) {
        await new Promise<void>((resolve) => {
          this.socket!.close(() => resolve());
        });
        this.socket = undefined;
      }

      this.circuitBreaker.destroy();
      this.retryManager.destroy();
      this.connections.clear();

      this.isStarted = false;
      this.emit('stopped');
    } catch (error) {
      this.emit('stop-error', error);
      throw error;
    }
  }

  async send(message: Message, target: NodeId): Promise<void> {
    if (!this.isStarted) {
      throw new Error('UDP adapter not started');
    }

    const operationId = `send-${target.id}-${Date.now()}`;
    
    await this.retryManager.execute(async () => {
      await this.sendMessage(message, target);
    }, operationId);
  }

  async broadcast(message: Message): Promise<void> {
    if (!this.isStarted) {
      throw new Error('UDP adapter not started');
    }

    if (this.options.enableMulticast && this.multicastSocket) {
      await this.sendMulticast(message);
    } else if (this.options.enableBroadcast) {
      await this.sendBroadcast(message);
    } else {
      throw new Error('Broadcasting not enabled');
    }
  }

  onMessage(callback: (message: Message) => void): void {
    this.messageHandlers.add(callback);
  }

  removeMessageListener(callback: (message: Message) => void): void {
    this.messageHandlers.delete(callback);
  }

  getConnectedNodes(): NodeId[] {
    return Array.from(this.connections.values())
      .filter(conn => conn.isReachable)
      .map(conn => conn.nodeId);
  }

  private async setupMulticast(): Promise<void> {
    this.multicastSocket = dgram.createSocket('udp4');
    this.multicastSocket.unref(); // Prevent Jest hanging
    
    this.multicastSocket.on('message', (msg, rinfo) => this.handleMulticastMessage(msg, rinfo));
    this.multicastSocket.on('error', (error) => this.handleMulticastError(error));

    await new Promise<void>((resolve, reject) => {
      this.multicastSocket!.bind(this.options.multicastPort, () => {
        try {
          this.multicastSocket!.addMembership(this.options.multicastAddress);
          this.log(`Joined multicast group ${this.options.multicastAddress}:${this.options.multicastPort}`);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private async sendMessage(message: Message, target: NodeId): Promise<void> {
    if (!this.socket) {
      throw new Error('UDP socket not available');
    }

    const packet = this.createPacket(message);
    const targetPort = target.port || this.options.port;

    return new Promise<void>((resolve, reject) => {
      this.socket!.send(packet, targetPort, target.address, (error) => {
        if (error) {
          this.handleConnectionError(target, error);
          reject(error);
        } else {
          this.updateConnectionStats(target, 'sent');
          this.emit('message-sent', { target, message, size: packet.length });
          resolve();
        }
      });
    });
  }

  private async sendMulticast(message: Message): Promise<void> {
    if (!this.multicastSocket) {
      throw new Error('Multicast socket not available');
    }

    const packet = this.createPacket(message);

    return new Promise<void>((resolve, reject) => {
      this.multicastSocket!.send(
        packet, 
        this.options.multicastPort, 
        this.options.multicastAddress, 
        (error) => {
          if (error) {
            reject(error);
          } else {
            this.emit('multicast-sent', { message, size: packet.length });
            resolve();
          }
        }
      );
    });
  }

  private async sendBroadcast(message: Message): Promise<void> {
    if (!this.socket) {
      throw new Error('UDP socket not available');
    }

    const packet = this.createPacket(message);
    const broadcastAddress = '255.255.255.255';

    return new Promise<void>((resolve, reject) => {
      this.socket!.send(packet, this.options.port, broadcastAddress, (error) => {
        if (error) {
          reject(error);
        } else {
          this.emit('broadcast-sent', { message, size: packet.length });
          resolve();
        }
      });
    });
  }

  private createPacket(message: Message): Buffer {
    const envelope = {
      fromNodeId: this.nodeId.id,
      timestamp: Date.now(),
      message
    };

    const json = JSON.stringify(envelope);
    const buffer = Buffer.from(json, 'utf8');

    if (buffer.length > this.options.maxPacketSize) {
      throw new Error(`Message too large: ${buffer.length} bytes (max: ${this.options.maxPacketSize})`);
    }

    return buffer;
  }

  private handleMessage(buffer: Buffer, rinfo: dgram.RemoteInfo): void {
    try {
      const envelope = JSON.parse(buffer.toString('utf8'));
      const fromNodeId = envelope.fromNodeId;
      const message = envelope.message;

      // Update connection info
      const nodeId: NodeId = {
        id: fromNodeId,
        address: rinfo.address,
        port: rinfo.port
      };

      this.updateConnectionStats(nodeId, 'received');

      // Process message
      this.messageHandlers.forEach(handler => {
        try {
          handler(message);
        } catch (error) {
          this.emit('handler-error', { error, fromNodeId });
        }
      });

      this.emit('message-received', { 
        message, 
        from: nodeId, 
        size: buffer.length,
        timestamp: envelope.timestamp
      });
    } catch (error) {
      this.emit('message-parse-error', { 
        error, 
        remoteAddress: rinfo.address, 
        remotePort: rinfo.port 
      });
    }
  }

  private handleMulticastMessage(buffer: Buffer, rinfo: dgram.RemoteInfo): void {
    try {
      const envelope = JSON.parse(buffer.toString('utf8'));
      
      // Ignore messages from self
      if (envelope.fromNodeId === this.nodeId.id) {
        return;
      }

      this.emit('multicast-received', {
        message: envelope.message,
        from: {
          id: envelope.fromNodeId,
          address: rinfo.address,
          port: rinfo.port
        },
        size: buffer.length,
        timestamp: envelope.timestamp
      });

      // Process as regular message
      this.handleMessage(buffer, rinfo);
    } catch (error) {
      this.emit('multicast-parse-error', { 
        error, 
        remoteAddress: rinfo.address, 
        remotePort: rinfo.port 
      });
    }
  }

  private updateConnectionStats(nodeId: NodeId, operation: 'sent' | 'received'): void {
    let connection = this.connections.get(nodeId.id);
    
    if (!connection) {
      connection = {
        nodeId,
        lastActivity: Date.now(),
        packetsSent: 0,
        packetsReceived: 0,
        isReachable: true
      };
      this.connections.set(nodeId.id, connection);
    }

    connection.lastActivity = Date.now();
    connection.isReachable = true;

    if (operation === 'sent') {
      connection.packetsSent++;
    } else {
      connection.packetsReceived++;
    }
  }

  private handleConnectionError(target: NodeId, error: Error): void {
    const connection = this.connections.get(target.id);
    if (connection) {
      connection.isReachable = false;
    }
    this.emit('connection-error', { nodeId: target, error });
    this.log(`Connection error to ${target.id}: ${error.message}`);
  }

  private handleSocketError(error: Error): void {
    this.emit('socket-error', error);
    this.log(`UDP socket error: ${error.message}`);
  }

  private handleMulticastError(error: Error): void {
    this.emit('multicast-error', error);
    this.log(`Multicast error: ${error.message}`);
  }

  getStats(): {
    isStarted: boolean;
    activeConnections: number;
    reachableNodes: number;
    totalConnections: number;
    port: number;
    host: string;
    multicastEnabled: boolean;
    broadcastEnabled: boolean;
    packetStats: {
      totalSent: number;
      totalReceived: number;
    };
  } {
    const reachableNodes = Array.from(this.connections.values())
      .filter(conn => conn.isReachable).length;

    const packetStats = Array.from(this.connections.values()).reduce(
      (acc, conn) => ({
        totalSent: acc.totalSent + conn.packetsSent,
        totalReceived: acc.totalReceived + conn.packetsReceived
      }),
      { totalSent: 0, totalReceived: 0 }
    );

    return {
      isStarted: this.isStarted,
      activeConnections: this.connections.size,
      reachableNodes,
      totalConnections: this.connections.size,
      port: this.options.port,
      host: this.options.host,
      multicastEnabled: this.options.enableMulticast,
      broadcastEnabled: this.options.enableBroadcast,
      packetStats
    };
  }

  private log(message: string): void {
    if (this.options.enableLogging) {
      console.log(`[UDPAdapter:${this.nodeId.id}] ${message}`);
    }
  }
}
