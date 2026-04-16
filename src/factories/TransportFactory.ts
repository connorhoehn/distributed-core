import { Transport } from '../transport/Transport';
import { WebSocketAdapter } from '../transport/adapters/WebSocketAdapter';
import { TCPAdapter } from '../transport/adapters/TCPAdapter';
import { NodeId } from '../types';

export interface TransportConfig {
  type: 'websocket' | 'tcp' | 'grpc' | 'custom';
  address: string;
  port: number;
  host?: string;
  options?: any;
  customTransport?: Transport;
}

/**
 * Factory for creating transport instances
 * Abstracts transport creation logic from the main node factory
 */
export class TransportFactory {
  private static instance: TransportFactory;

  static getInstance(): TransportFactory {
    if (!TransportFactory.instance) {
      TransportFactory.instance = new TransportFactory();
    }
    return TransportFactory.instance;
  }

  private constructor() {}

  /**
   * Create a transport based on configuration
   */
  createTransport(nodeId: string, config: TransportConfig): Transport {
    if (config.customTransport) {
      return config.customTransport;
    }

    const nodeIdObj: NodeId = {
      id: nodeId,
      address: config.address,
      port: config.port
    };

    const transportOptions = {
      host: config.host || '0.0.0.0',
      port: config.port,
      ...(config.options || {})
    };

    switch (config.type) {
      case 'websocket':
        return new WebSocketAdapter(nodeIdObj, transportOptions);

      case 'tcp':
        return new TCPAdapter(nodeIdObj, transportOptions);

      case 'grpc':
        throw new Error('gRPC transport is not yet supported. Use "websocket" or "tcp" instead.');

      default:
        throw new Error(`Unsupported transport type: ${config.type}`);
    }
  }

  /**
   * Create multiple transports (e.g., one for cluster, one for client)
   */
  createTransports(nodeId: string, configs: {
    cluster?: TransportConfig;
    client?: TransportConfig;
  }): {
    cluster?: Transport;
    client?: Transport;
  } {
    const transports: { cluster?: Transport; client?: Transport } = {};

    if (configs.cluster) {
      transports.cluster = this.createTransport(nodeId, configs.cluster);
    }

    if (configs.client) {
      // Add port offset for client transport to avoid conflicts
      const clientConfig = {
        ...configs.client,
        port: configs.client.port + 1000
      };
      transports.client = this.createTransport(nodeId, clientConfig);
    }

    return transports;
  }
}

/**
 * Builder for creating transport configurations
 */
export class TransportConfigBuilder {
  private config: Partial<TransportConfig> = {};

  type(type: 'websocket' | 'tcp' | 'grpc'): this {
    this.config.type = type;
    return this;
  }

  address(address: string): this {
    this.config.address = address;
    return this;
  }

  port(port: number): this {
    this.config.port = port;
    return this;
  }

  host(host: string): this {
    this.config.host = host;
    return this;
  }

  options(options: any): this {
    this.config.options = options;
    return this;
  }

  custom(transport: Transport): this {
    this.config.type = 'custom';
    this.config.customTransport = transport;
    return this;
  }

  build(): TransportConfig {
    if (!this.config.type) {
      throw new Error('Transport type is required');
    }
    if (this.config.type !== 'custom' && (!this.config.address || !this.config.port)) {
      throw new Error('Address and port are required for non-custom transports');
    }

    return this.config as TransportConfig;
  }

  static create(): TransportConfigBuilder {
    return new TransportConfigBuilder();
  }
}
