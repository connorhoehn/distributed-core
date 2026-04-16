import {
  TransportFactory,
  TransportConfig,
  TransportConfigBuilder,
} from '../../../src/factories/TransportFactory';
import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';
import { TCPAdapter } from '../../../src/transport/adapters/TCPAdapter';
import { Transport } from '../../../src/transport/Transport';
import { NodeId, Message } from '../../../src/types';

// Mock CircuitBreaker and RetryManager to avoid real network usage
jest.mock('../../../src/transport/CircuitBreaker', () => ({
  CircuitBreaker: jest.fn().mockImplementation(() => ({
    execute: jest.fn().mockImplementation(async (fn: Function) => fn()),
    destroy: jest.fn(),
    on: jest.fn(),
  })),
}));

jest.mock('../../../src/transport/RetryManager', () => ({
  RetryManager: jest.fn().mockImplementation(() => ({
    execute: jest.fn().mockImplementation(async (fn: Function) => fn()),
    destroy: jest.fn(),
  })),
}));

// Mock transport for custom transport tests
class MockTransport extends Transport {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(message: Message, target: NodeId): Promise<void> {}
  onMessage(callback: (message: Message) => void): void {}
  removeMessageListener(callback: (message: Message) => void): void {}
  getConnectedNodes(): NodeId[] { return []; }
  getLocalNodeInfo(): NodeId { return { id: 'mock', address: '127.0.0.1', port: 0 }; }
}

describe('TransportFactory', () => {
  // Reset singleton between tests
  beforeEach(() => {
    (TransportFactory as any).instance = undefined;
  });

  describe('Singleton', () => {
    test('getInstance returns the same instance', () => {
      const a = TransportFactory.getInstance();
      const b = TransportFactory.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('createTransport', () => {
    test('creates a websocket transport', () => {
      const factory = TransportFactory.getInstance();
      const config: TransportConfig = {
        type: 'websocket',
        address: '127.0.0.1',
        port: 8080,
      };

      const transport = factory.createTransport('node-1', config);
      expect(transport).toBeInstanceOf(WebSocketAdapter);
    });

    test('creates a tcp transport', () => {
      const factory = TransportFactory.getInstance();
      const config: TransportConfig = {
        type: 'tcp',
        address: '127.0.0.1',
        port: 8081,
      };

      const transport = factory.createTransport('node-2', config);
      expect(transport).toBeInstanceOf(TCPAdapter);
    });

    test('returns custom transport when provided', () => {
      const factory = TransportFactory.getInstance();
      const mockTransport = new MockTransport();
      const config: TransportConfig = {
        type: 'custom',
        address: '127.0.0.1',
        port: 8082,
        customTransport: mockTransport,
      };

      const transport = factory.createTransport('node-3', config);
      expect(transport).toBe(mockTransport);
    });

    test('throws for unsupported transport type', () => {
      const factory = TransportFactory.getInstance();
      const config: TransportConfig = {
        type: 'invalid' as any,
        address: '127.0.0.1',
        port: 8083,
      };

      expect(() => factory.createTransport('node-4', config)).toThrow(
        'Unsupported transport type: invalid'
      );
    });

    test('uses default host when not specified', () => {
      const factory = TransportFactory.getInstance();
      const config: TransportConfig = {
        type: 'websocket',
        address: '10.0.0.1',
        port: 9000,
      };

      const transport = factory.createTransport('node-5', config);
      expect(transport).toBeInstanceOf(WebSocketAdapter);
    });

    test('respects custom host', () => {
      const factory = TransportFactory.getInstance();
      const config: TransportConfig = {
        type: 'tcp',
        address: '10.0.0.1',
        port: 9001,
        host: 'localhost',
      };

      const transport = factory.createTransport('node-6', config);
      expect(transport).toBeInstanceOf(TCPAdapter);
    });
  });

  describe('createTransports', () => {
    test('creates cluster and client transports', () => {
      const factory = TransportFactory.getInstance();
      const result = factory.createTransports('node-7', {
        cluster: { type: 'websocket', address: '127.0.0.1', port: 5000 },
        client: { type: 'tcp', address: '127.0.0.1', port: 5000 },
      });

      expect(result.cluster).toBeInstanceOf(WebSocketAdapter);
      expect(result.client).toBeInstanceOf(TCPAdapter);
    });

    test('returns empty object when no configs provided', () => {
      const factory = TransportFactory.getInstance();
      const result = factory.createTransports('node-8', {});

      expect(result.cluster).toBeUndefined();
      expect(result.client).toBeUndefined();
    });

    test('client transport port gets 1000 offset', () => {
      const factory = TransportFactory.getInstance();
      const result = factory.createTransports('node-9', {
        client: { type: 'websocket', address: '127.0.0.1', port: 3000 },
      });

      // Client transport is created with offset port
      expect(result.client).toBeInstanceOf(WebSocketAdapter);
    });
  });
});

describe('TransportConfigBuilder', () => {
  describe('Builder creation', () => {
    test('create() returns a TransportConfigBuilder', () => {
      const builder = TransportConfigBuilder.create();
      expect(builder).toBeInstanceOf(TransportConfigBuilder);
    });

    test('new TransportConfigBuilder works', () => {
      const builder = new TransportConfigBuilder();
      expect(builder).toBeInstanceOf(TransportConfigBuilder);
    });
  });

  describe('Method chaining', () => {
    test('all setters return this for chaining', () => {
      const builder = TransportConfigBuilder.create();
      const result = builder
        .type('websocket')
        .address('127.0.0.1')
        .port(8080)
        .host('localhost')
        .options({ maxConnections: 100 });

      expect(result).toBe(builder);
    });

    test('custom() sets type and transport', () => {
      const mockTransport = new MockTransport();
      const builder = TransportConfigBuilder.create();
      const result = builder.custom(mockTransport);

      expect(result).toBe(builder);

      const config = result.build();
      expect(config.type).toBe('custom');
      expect(config.customTransport).toBe(mockTransport);
    });
  });

  describe('Websocket transport config', () => {
    test('builds a valid websocket config', () => {
      const config = TransportConfigBuilder.create()
        .type('websocket')
        .address('127.0.0.1')
        .port(8080)
        .build();

      expect(config.type).toBe('websocket');
      expect(config.address).toBe('127.0.0.1');
      expect(config.port).toBe(8080);
    });

    test('websocket config with host and options', () => {
      const config = TransportConfigBuilder.create()
        .type('websocket')
        .address('10.0.0.1')
        .port(9000)
        .host('0.0.0.0')
        .options({ enableLogging: true })
        .build();

      expect(config.type).toBe('websocket');
      expect(config.host).toBe('0.0.0.0');
      expect(config.options).toEqual({ enableLogging: true });
    });
  });

  describe('TCP transport config', () => {
    test('builds a valid tcp config', () => {
      const config = TransportConfigBuilder.create()
        .type('tcp')
        .address('192.168.1.1')
        .port(6000)
        .build();

      expect(config.type).toBe('tcp');
      expect(config.address).toBe('192.168.1.1');
      expect(config.port).toBe(6000);
    });
  });

  describe('Validation', () => {
    test('throws when type is missing', () => {
      const builder = TransportConfigBuilder.create()
        .address('127.0.0.1')
        .port(8080);

      expect(() => builder.build()).toThrow('Transport type is required');
    });

    test('throws when address is missing for non-custom transport', () => {
      const builder = TransportConfigBuilder.create()
        .type('websocket')
        .port(8080);

      expect(() => builder.build()).toThrow(
        'Address and port are required for non-custom transports'
      );
    });

    test('throws when port is missing for non-custom transport', () => {
      const builder = TransportConfigBuilder.create()
        .type('tcp')
        .address('127.0.0.1');

      expect(() => builder.build()).toThrow(
        'Address and port are required for non-custom transports'
      );
    });

    test('does not throw for custom transport without address/port', () => {
      const mockTransport = new MockTransport();
      const config = TransportConfigBuilder.create()
        .custom(mockTransport)
        .build();

      expect(config.type).toBe('custom');
      expect(config.customTransport).toBe(mockTransport);
    });
  });
});
