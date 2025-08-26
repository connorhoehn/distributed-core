/**
 * Unit tests for NetworkService
 */

import { NetworkService } from '../../../src/services/adapters/NetworkService';
import { Transport } from '../../../src/transport/Transport';
import { Message } from '../../../src/types';

// Mock transport implementation
class MockTransport implements Transport {
  private messageHandler?: (message: Message) => void;
  private started = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  onMessage(handler: (message: Message) => void): void {
    this.messageHandler = handler;
  }

  removeMessageListener(handler: (message: Message) => void): void {
    if (this.messageHandler === handler) {
      this.messageHandler = undefined;
    }
  }

  async send(message: Message, target?: any): Promise<void> {
    // Mock implementation
  }

  isStarted(): boolean {
    return this.started;
  }

  simulateMessage(message: Message): void {
    if (this.messageHandler) {
      this.messageHandler(message);
    }
  }
}

describe('NetworkService', () => {
  let clusterTransport: MockTransport;
  let clientTransport: MockTransport;
  let networkService: NetworkService;

  beforeEach(() => {
    clusterTransport = new MockTransport();
    clientTransport = new MockTransport();
    networkService = new NetworkService(clusterTransport, clientTransport);
  });

  it('should start cluster transport when run is called', async () => {
    await networkService.run();
    
    expect(clusterTransport.isStarted()).toBe(true);
    expect(clientTransport.isStarted()).toBe(false); // Client transport starts separately
  });

  it('should bind cluster transport', async () => {
    await networkService.bindCluster();
    
    expect(clusterTransport.isStarted()).toBe(true);
  });

  it('should bind client transport', async () => {
    await networkService.bindClient();
    
    expect(clientTransport.isStarted()).toBe(true);
  });

  it('should register cluster message handler', async () => {
    const messageHandler = jest.fn();
    networkService.onClusterMessage(messageHandler);
    
    await networkService.bindCluster();
    
    // Simulate incoming message
    const testMessage: Message = {
      id: 'test',
      type: 'GOSSIP' as any,
      sender: { id: 'node1', address: 'localhost', port: 8080 },
      timestamp: Date.now(),
      data: { test: 'data' }
    };
    
    clusterTransport.simulateMessage(testMessage);
    
    expect(messageHandler).toHaveBeenCalledWith(testMessage);
  });

  it('should stop both transports', async () => {
    await networkService.bindCluster();
    await networkService.bindClient();
    
    expect(clusterTransport.isStarted()).toBe(true);
    expect(clientTransport.isStarted()).toBe(true);
    
    await networkService.stop();
    
    expect(clusterTransport.isStarted()).toBe(false);
    expect(clientTransport.isStarted()).toBe(false);
  });

  it('should return transport instances', () => {
    expect(networkService.getClusterTransport()).toBe(clusterTransport);
    expect(networkService.getClientTransport()).toBe(clientTransport);
  });
});
