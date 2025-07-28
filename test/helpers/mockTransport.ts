import { Transport } from '../../src/transport/Transport';
import { NodeId, Message } from '../../src/types';

/**
 * Lightweight mock transport for testing
 */
export class MockTransport extends Transport {
  private nodeId: NodeId;
  public sentMessages: Message[] = [];
  
  constructor(nodeId: NodeId) {
    super();
    this.nodeId = nodeId;
  }

  async start(): Promise<void> {
    // Stub implementation
  }

  async stop(): Promise<void> {
    // Stub implementation
  }

  async send(message: Message, target: NodeId): Promise<void> {
    this.sentMessages.push(message);
    // Stub implementation - no actual network send
  }

  getMessageCount(): number {
    return this.sentMessages.length;
  }

  clearMessages(): void {
    this.sentMessages = [];
  }
}

/**
 * Factory function for creating mock transports
 */
export function mockTransport(nodeId: NodeId): MockTransport {
  return new MockTransport(nodeId);
}
