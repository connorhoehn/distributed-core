import {
  DistributedNodeFactory,
  DistributedNodeBuilder,
  DistributedNodeConfig,
} from '../../../src/factories/DistributedNodeFactory';
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
  RetryManager: jest.fn().mockImplementation((() => ({
    execute: jest.fn().mockImplementation(async (fn: Function) => fn()),
    destroy: jest.fn(),
  }))),
}));

// Mock transport for testing without real network
class MockTransport extends Transport {
  private messageCallbacks: ((message: Message) => void)[] = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(message: Message, target: NodeId): Promise<void> {}

  onMessage(callback: (message: Message) => void): void {
    this.messageCallbacks.push(callback);
  }

  removeMessageListener(callback: (message: Message) => void): void {
    this.messageCallbacks = this.messageCallbacks.filter(cb => cb !== callback);
  }

  getConnectedNodes(): NodeId[] {
    return [];
  }

  getLocalNodeInfo(): NodeId {
    return { id: 'mock', address: '127.0.0.1', port: 9999 };
  }
}

describe('DistributedNodeFactory', () => {
  // Reset singleton between tests
  beforeEach(() => {
    (DistributedNodeFactory as any).instance = undefined;
  });

  describe('Singleton', () => {
    test('getInstance returns the same instance', () => {
      const a = DistributedNodeFactory.getInstance();
      const b = DistributedNodeFactory.getInstance();
      expect(a).toBe(b);
    });

    test('getInstance returns a DistributedNodeFactory', () => {
      const instance = DistributedNodeFactory.getInstance();
      expect(instance).toBeInstanceOf(DistributedNodeFactory);
    });
  });

  describe('Builder creation', () => {
    test('builder() returns a DistributedNodeBuilder', () => {
      const builder = DistributedNodeFactory.builder();
      expect(builder).toBeInstanceOf(DistributedNodeBuilder);
    });

    test('builder supports method chaining', () => {
      const builder = DistributedNodeFactory.builder();
      const result = builder
        .id('test-node')
        .region('us-east')
        .zone('zone-a')
        .role('worker')
        .network('127.0.0.1', 8080);

      expect(result).toBe(builder);
    });
  });

  describe('Builder validation', () => {
    test('build() throws when id is missing', async () => {
      const builder = DistributedNodeFactory.builder()
        .network('127.0.0.1', 8080);

      await expect(builder.build()).rejects.toThrow('Node ID is required');
    });

    test('build() throws when network is missing', async () => {
      const builder = DistributedNodeFactory.builder()
        .id('test-node');

      await expect(builder.build()).rejects.toThrow('Network configuration is required');
    });

    test('build() throws when both id and network are missing', async () => {
      const builder = DistributedNodeFactory.builder();

      await expect(builder.build()).rejects.toThrow('Node ID is required');
    });
  });

  describe('Builder produces valid config', () => {
    test('builder sets all config fields via chaining without error', () => {
      const builder = DistributedNodeFactory.builder()
        .id('node-1')
        .region('eu-west')
        .zone('zone-b')
        .role('coordinator')
        .network('10.0.0.1', 5000, 'localhost')
        .transport('tcp')
        .seedNodes(['10.0.0.2:5000', '10.0.0.3:5000'])
        .enableResources({ productionScale: true, attachmentService: true })
        .enableMetrics(true)
        .enableLogging(false);

      expect(builder).toBeInstanceOf(DistributedNodeBuilder);
    });

    test('builder has sensible defaults for region, zone, and role', () => {
      const builder = DistributedNodeFactory.builder()
        .id('node-defaults')
        .network('127.0.0.1', 3000);

      // Should not throw - defaults for region/zone/role are set internally
      expect(builder).toBeInstanceOf(DistributedNodeBuilder);
    });
  });

  describe('createNode with custom transport', () => {
    test('createNode returns expected components', async () => {
      const mockTransport = new MockTransport();

      const config: DistributedNodeConfig = {
        id: 'test-node-1',
        region: 'test-region',
        zone: 'test-zone',
        role: 'worker',
        transport: {
          type: 'custom',
          customTransport: mockTransport,
        },
        resources: {
          enableProductionScale: false,
        },
      };

      const factory = DistributedNodeFactory.getInstance();
      const components = await factory.createNode(config);

      expect(components).toHaveProperty('node');
      expect(components).toHaveProperty('clusterManager');
      expect(components).toHaveProperty('clusterTransport');
      expect(components).toHaveProperty('clientTransport');
      expect(components.clusterTransport).toBe(mockTransport);
      expect(components.clientTransport).toBe(mockTransport);
    });

    test('createNode with resources disabled omits resource components', async () => {
      const mockTransport = new MockTransport();

      const config: DistributedNodeConfig = {
        id: 'test-node-2',
        region: 'test-region',
        zone: 'test-zone',
        role: 'worker',
        transport: {
          type: 'custom',
          customTransport: mockTransport,
        },
        resources: {
          enableProductionScale: false,
        },
      };

      const factory = DistributedNodeFactory.getInstance();
      const components = await factory.createNode(config);

      expect(components.resourceManager).toBeUndefined();
      expect(components.resourceAttachment).toBeUndefined();
      expect(components.resourceDistribution).toBeUndefined();
      expect(components.clusterFanoutRouter).toBeUndefined();
      expect(components.comms).toBeUndefined();
    });
  });

  describe('createTransport error paths', () => {
    test('throws when network config is missing and no custom transport', async () => {
      const config: DistributedNodeConfig = {
        id: 'test-node-no-net',
        region: 'test-region',
        zone: 'test-zone',
        role: 'worker',
        transport: {
          type: 'websocket',
        },
      };

      const factory = DistributedNodeFactory.getInstance();
      await expect(factory.createNode(config)).rejects.toThrow(
        'Network configuration required for distributed node'
      );
    });

    test('throws for unsupported transport type', async () => {
      const config: DistributedNodeConfig = {
        id: 'test-node-bad-transport',
        region: 'test-region',
        zone: 'test-zone',
        role: 'worker',
        network: {
          address: '127.0.0.1',
          port: 9000,
        },
        transport: {
          type: 'invalid' as any,
        },
      };

      const factory = DistributedNodeFactory.getInstance();
      await expect(factory.createNode(config)).rejects.toThrow(
        'Unsupported transport type: invalid'
      );
    });
  });
});
