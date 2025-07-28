import { Transport } from '../Transport';
import { NodeId, Message } from '../../types';
import { EventEmitter } from 'events';

/**
 * In-memory transport adapter for local testing and simulations
 * Provides fast, deterministic communication without network overhead
 */
export class InMemoryAdapter extends Transport {
  private static registry = new Map<string, InMemoryAdapter>();
  private nodeId: NodeId;
  private eventEmitter = new EventEmitter();
  private isStarted = false;

  constructor(nodeId: NodeId) {
    super();
    this.nodeId = nodeId;
  }

  async start(): Promise<void> {
    if (this.isStarted) return;
    
    InMemoryAdapter.registry.set(this.nodeId.id, this);
    this.isStarted = true;
    this.emit('started');
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;
    
    InMemoryAdapter.registry.delete(this.nodeId.id);
    this.eventEmitter.removeAllListeners();
    this.isStarted = false;
    this.emit('stopped');
  }

  async send(message: Message, target: NodeId): Promise<void> {
    if (!this.isStarted) {
      throw new Error('Adapter not started');
    }

    const targetAdapter = InMemoryAdapter.registry.get(target.id);
    if (!targetAdapter) {
      throw new Error(`Target node ${target.id} not found`);
    }

    // Simulate async delivery with next tick
    process.nextTick(() => {
      targetAdapter.eventEmitter.emit('message', message);
    });
  }

  onMessage(callback: (message: Message) => void): void {
    this.eventEmitter.on('message', callback);
  }

  removeMessageListener(callback: (message: Message) => void): void {
    this.eventEmitter.removeListener('message', callback);
  }

  getConnectedNodes(): NodeId[] {
    return Array.from(InMemoryAdapter.registry.keys())
      .filter(id => id !== this.nodeId.id)
      .map(id => InMemoryAdapter.registry.get(id)!.nodeId);
  }

  /**
   * Clear all adapters from registry (for testing)
   */
  static clearRegistry(): void {
    InMemoryAdapter.registry.clear();
  }
}
