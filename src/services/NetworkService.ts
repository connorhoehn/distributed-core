import { Transport } from '../transport/Transport';
import { WebSocketAdapter } from '../transport/adapters/WebSocketAdapter';
import { TCPAdapter } from '../transport/adapters/TCPAdapter';
import { NodeId } from '../types';
import { Logger } from '../common/logger';

export interface NetworkConfig {
  nodeId: string;
  address: string;
  port: number;
  host?: string;
  transport?: {
    type: 'websocket' | 'tcp' | 'grpc' | 'custom';
    options?: any;
    customTransport?: Transport;
  };
}

export interface NetworkTransports {
  clusterTransport: Transport;
  clientTransport: Transport;
}

/**
 * NetworkService - Phase 2: Network Bind
 * 
 * Responsibilities:
 * - Create cluster transport (node↔node) and client transport (client↔node)
 * - Manage transport lifecycle (start/stop)
 * - Handle port allocation and binding
 */
export class NetworkService {
  private transports?: NetworkTransports;
  private logger = Logger.create('NetworkService');

  constructor(private config: NetworkConfig) {}

  /**
   * Create and bind both cluster and client transports
   */
  async start(): Promise<NetworkTransports> {
    this.logger.info('Creating cluster and client transports...');
    
    // Create cluster transport (node↔node communication)
    const clusterTransport = this.createTransport('cluster');
    
    // Create client transport (client↔node communication) with port offset
    const clientTransport = this.createTransport('client');

    // Start both transports
    await Promise.all([
      clusterTransport.start(),
      clientTransport.start()
    ]);

    this.transports = { clusterTransport, clientTransport };
    
    this.logger.info(`Bound cluster transport on ${this.config.address}:${this.config.port}`);
    this.logger.info(`Bound client transport on ${this.config.address}:${this.config.port + 1000}`);
    
    return this.transports;
  }

  /**
   * Stop both transports
   */
  async stop(): Promise<void> {
    if (!this.transports) return;

    this.logger.info('Stopping transports...');
    
    await Promise.all([
      this.transports.clusterTransport.stop(),
      this.transports.clientTransport.stop()
    ]);

    this.transports = undefined;
    this.logger.info('Transports stopped');
  }

  /**
   * Get current transports (throws if not started)
   */
  getTransports(): NetworkTransports {
    if (!this.transports) {
      throw new Error('NetworkService not started - call start() first');
    }
    return this.transports;
  }

  /**
   * Create transport based on type and configuration
   */
  private createTransport(type: 'cluster' | 'client'): Transport {
    if (this.config.transport?.customTransport) {
      return this.config.transport.customTransport;
    }

    const nodeId: NodeId = {
      id: this.config.nodeId,
      address: this.config.address,
      port: this.config.port
    };

    const transportType = this.config.transport?.type || 'websocket';
    const transportOptions = this.config.transport?.options || {};

    // Client transport uses port offset to avoid conflicts
    const portOffset = type === 'client' ? 1000 : 0;
    const effectivePort = this.config.port + portOffset;

    switch (transportType) {
      case 'websocket':
        return new WebSocketAdapter({
          id: this.config.nodeId,
          address: this.config.address,
          port: effectivePort
        }, {
          host: this.config.host || '0.0.0.0',
          port: effectivePort,
          ...transportOptions
        });

      case 'tcp':
        return new TCPAdapter({
          id: this.config.nodeId,
          address: this.config.address,
          port: effectivePort
        }, {
          host: this.config.host || '0.0.0.0',
          port: effectivePort,
          ...transportOptions
        });

      case 'grpc':
        throw new Error('gRPC transport is not yet supported. Use "websocket" or "tcp" instead.');

      default:
        throw new Error(`Unsupported transport type: ${transportType}`);
    }
  }
}
