/**
 * CommunicationCoordinator - High-level communication abstraction  
 * 
 * Hides the complexity of:
 * - Message serialization/deserialization
 * - Pub/Sub semantics and ordering
 * - Message delivery guarantees
 * - Flow control and backpressure
 * 
 * Provides simple interface for:
 * - Publishing messages to resources
 * - Subscribing to resource updates
 * - Managing client connections
 * - Communication health and metrics
 */

import { IntegratedCommunicationLayer } from '../communication/core/IntegratedCommunicationLayer';

export interface CommunicationCoordinatorConfig {
  nodeId: string;
  enableObservability?: boolean;
  maxQueueSize?: number;
  messageTimeoutMs?: number;
}

export interface MessageInfo {
  id: string;
  resourceId: string;
  timestamp: number;
  size: number;
  type: string;
  sourceNodeId: string;
}

export interface CommunicationMetrics {
  messagesPublished: number;
  messagesDelivered: number;
  activeSubscriptions: number;
  queueDepth: number;
  averageLatency: number;
  errorRate: number;
}

/**
 * High-level communication abstraction
 * Hides messaging complexity and provides clean pub/sub interface
 */
export class CommunicationCoordinator {
  private comms: IntegratedCommunicationLayer;
  private isStarted: boolean = false;

  constructor(comms: IntegratedCommunicationLayer) {
    this.comms = comms;
  }

  /**
   * Start communication coordination
   */
  async start(): Promise<void> {
    if (this.isStarted) return;
    
    await this.comms.start();
    this.isStarted = true;
  }

  /**
   * Stop communication coordination  
   */
  async stop(): Promise<void> {
    if (!this.isStarted) return;
    
    await this.comms.stop();
    this.isStarted = false;
  }

  /**
   * Publish message to a resource (from client connection)
   */
  async publish(
    connectionId: string,
    resourceId: string,
    message: any
  ): Promise<void> {
    const payload = Buffer.from(JSON.stringify(message));
    await this.comms.publisher.publishFromClient(connectionId, resourceId, payload);
  }

  /**
   * Subscribe connection to resource updates
   */
  async subscribe(
    connectionId: string,
    resourceId: string
  ): Promise<void> {
    await this.comms.subscriber.join(connectionId, resourceId);
  }

  /**
   * Unsubscribe connection from resource
   */
  async unsubscribe(
    connectionId: string,
    resourceId: string
  ): Promise<void> {
    await this.comms.subscriber.leave(connectionId, resourceId);
  }

  /**
   * Get subscribers for a resource
   */
  async getSubscribers(resourceId: string): Promise<string[]> {
    const members = await this.comms.attachment.members(resourceId);
    return Array.from(members);
  }

  /**
   * Get communication metrics
   */
  async getMetrics(): Promise<CommunicationMetrics> {
    const observability = this.comms.observability;
    if (!observability) {
      return {
        messagesPublished: 0,
        messagesDelivered: 0,
        activeSubscriptions: 0,
        queueDepth: 0,
        averageLatency: 0,
        errorRate: 0
      };
    }

    const metrics = observability.getMetrics();
    return {
      messagesPublished: metrics.operations.total,
      messagesDelivered: metrics.operations.total - metrics.operations.errors,
      activeSubscriptions: Object.keys(metrics.queues.depth).length,
      queueDepth: Object.values(metrics.queues.depth).reduce((sum: number, depth: unknown) => sum + (typeof depth === 'number' ? depth : 0), 0),
      averageLatency: metrics.operations.averageLatencyMs,
      errorRate: metrics.operations.errors / Math.max(metrics.operations.total, 1)
    };
  }

  /**
   * Print communication summary
   */
  printSummary(): void {
    if (this.comms.observability) {
      this.comms.observability.printSummary();
    }
  }

  /**
   * Check if communication is ready
   */
  isReady(): boolean {
    return this.isStarted;
  }

  /**
   * Get underlying communication layer (for advanced use cases)
   * @deprecated Use high-level methods instead
   */
  getCommunicationLayer(): IntegratedCommunicationLayer {
    return this.comms;
  }
}
