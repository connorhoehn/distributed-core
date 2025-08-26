import { ResourceDistributionEngine } from './ResourceDistributionEngine';
import { ResourceRegistry } from './ResourceRegistry';
import { DistributedSemanticsConfig, DistributedSemanticsFlags } from './DistributedSemanticsConfig';
import { ResourceOperation, VectorClock, createResourceOperation, generateCorrelationContext, OpType } from './ResourceOperation';
import { OperationDeduplicator } from './OperationDeduplicator';
import { CausalOrderingEngine } from './CausalOrderingEngine';
import { SubscriptionDeduplicator } from './SubscriptionDeduplicator';
import { ResourceAuthorizationService, Principal, AuthResult } from './ResourceAuthorizationService';

export interface DistributedResourceConfig {
  nodeId: string;
  semanticsConfig?: DistributedSemanticsConfig;
  enableAuthorization?: boolean;
  enableDeduplication?: boolean;
  enableCausalOrdering?: boolean;
  enableSubscriptionDeduplication?: boolean;
}

export interface ResourceChangeEvent<T = any> {
  operation: ResourceOperation<T>;
  resource: any;
  metadata?: Record<string, any>;
}

/**
 * Comprehensive Distributed Resource Management System
 * 
 * This orchestrates all distributed semantics components:
 * - Operation deduplication for idempotency
 * - Causal ordering with vector clocks
 * - Subscription management with exactly-once delivery
 * - Authorization and access control
 * - Correlation tracking across distributed operations
 */
export class DistributedResourceManager {
  private readonly nodeId: string;
  private readonly semanticsConfig: DistributedSemanticsConfig;
  private readonly operationDeduplicator?: OperationDeduplicator;
  private readonly causalOrderingEngine?: CausalOrderingEngine;
  private readonly subscriptionDeduplicator?: SubscriptionDeduplicator;
  private readonly authorizationService?: ResourceAuthorizationService;
  private readonly localClock: VectorClock;
  private readonly eventHandlers: Map<string, Function[]> = new Map();

  constructor(config: DistributedResourceConfig) {
    this.nodeId = config.nodeId;
    this.semanticsConfig = config.semanticsConfig || new DistributedSemanticsConfig();

    // Initialize vector clock
    this.localClock = {
      nodeId: this.nodeId,
      vector: new Map([[this.nodeId, 0]]),
      increment: () => {
        const current = this.localClock.vector.get(this.nodeId) || 0;
        this.localClock.vector.set(this.nodeId, current + 1);
        return this.localClock;
      },
      compare: (other: VectorClock) => this.compareVectorClocks(this.localClock, other),
      merge: (other: VectorClock) => this.mergeVectorClocks(this.localClock, other)
    };

    // Initialize optional components based on configuration
    if (config.enableDeduplication) {
      this.operationDeduplicator = new OperationDeduplicator();
    }

    if (config.enableCausalOrdering) {
      this.causalOrderingEngine = new CausalOrderingEngine(this.nodeId);
    }

    if (config.enableSubscriptionDeduplication) {
      this.subscriptionDeduplicator = new SubscriptionDeduplicator();
    }

    if (config.enableAuthorization) {
      this.authorizationService = new ResourceAuthorizationService();
    }
  }

  /**
   * Create a new resource with distributed semantics
   */
  async createResource<T>(
    resourceId: string,
    payload: T,
    principal?: Principal,
    metadata?: Record<string, any>
  ): Promise<ResourceOperation<T>> {
    return this.performOperation('CREATE', resourceId, payload, principal, metadata);
  }

  /**
   * Update an existing resource with distributed semantics
   */
  async updateResource<T>(
    resourceId: string,
    payload: T,
    principal?: Principal,
    metadata?: Record<string, any>
  ): Promise<ResourceOperation<T>> {
    return this.performOperation('UPDATE', resourceId, payload, principal, metadata);
  }

  /**
   * Delete a resource with distributed semantics
   */
  async deleteResource(
    resourceId: string,
    principal?: Principal,
    metadata?: Record<string, any>
  ): Promise<ResourceOperation<null>> {
    return this.performOperation('DELETE', resourceId, null, principal, metadata);
  }

  /**
   * Transfer a resource to another node
   */
  async transferResource(
    resourceId: string,
    targetNodeId: string,
    principal?: Principal,
    metadata?: Record<string, any>
  ): Promise<ResourceOperation<{ targetNodeId: string }>> {
    const transferPayload = { targetNodeId };
    return this.performOperation('TRANSFER', resourceId, transferPayload, principal, metadata);
  }

  /**
   * Subscribe to resource changes with exactly-once delivery
   */
  subscribeToResource<T>(
    subscriptionId: string,
    resourcePattern: string,
    operationTypes: OpType[],
    handler: (operation: ResourceOperation<T>) => Promise<void>
  ): void {
    if (!this.subscriptionDeduplicator) {
      throw new Error('Subscription deduplication not enabled');
    }

    this.subscriptionDeduplicator.subscribe(
      subscriptionId,
      this.nodeId,
      resourcePattern,
      operationTypes,
      handler
    );
  }

  /**
   * Unsubscribe from resource changes
   */
  unsubscribeFromResource(subscriptionId: string): void {
    if (!this.subscriptionDeduplicator) {
      throw new Error('Subscription deduplication not enabled');
    }

    this.subscriptionDeduplicator.unsubscribe(subscriptionId);
  }

  /**
   * Process an incoming operation from another node
   */
  async processIncomingOperation<T>(operation: ResourceOperation<T>): Promise<void> {
    // Authorization check
    if (this.authorizationService) {
      const principal = this.extractPrincipalFromOperation(operation);
      if (principal) {
        const authResult = await this.authorizationService.authorizeOperation(principal, operation);
        if (!authResult.allowed) {
          throw new Error(`Operation ${operation.opId} unauthorized: ${authResult.reason}`);
        }
      }
    }

    // Causal ordering
    if (this.causalOrderingEngine) {
      await this.causalOrderingEngine.processOperation(operation, async (op) => {
        await this.executeOperation(op);
      });
    } else {
      await this.executeOperation(operation);
    }
  }

  /**
   * Get comprehensive statistics about the distributed resource system
   */
  getStats() {
    const stats: any = {
      nodeId: this.nodeId,
      vectorClock: Object.fromEntries(this.localClock.vector)
    };

    if (this.operationDeduplicator) {
      stats.deduplication = this.operationDeduplicator.getStats();
    }

    if (this.causalOrderingEngine) {
      stats.causalOrdering = this.causalOrderingEngine.getStats();
    }

    if (this.subscriptionDeduplicator) {
      stats.subscriptions = this.subscriptionDeduplicator.getStats();
    }

    if (this.authorizationService) {
      stats.authorization = this.authorizationService.getStats();
    }

    return stats;
  }

  /**
   * Simple event emitter functionality
   */
  on(event: string, handler: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(handler);
  }

  emit(event: string, data: any): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(data);
        } catch (error) {
          // Log error but don't throw
        }
      });
    }
  }

  /**
   * Shutdown the distributed resource manager
   */
  async shutdown(): Promise<void> {
    this.operationDeduplicator?.shutdown();
    this.causalOrderingEngine?.shutdown();
    this.subscriptionDeduplicator?.shutdown();
    
    this.eventHandlers.clear();
  }

  /**
   * Perform a resource operation with all distributed semantics
   */
  private async performOperation<T>(
    type: OpType,
    resourceId: string,
    payload: T,
    principal?: Principal,
    metadata?: Record<string, any>
  ): Promise<ResourceOperation<T>> {
    // Increment local clock for outgoing operation
    this.localClock.increment();

    // Generate correlation context
    const correlationContext = generateCorrelationContext();

    // Create operation
    const operation = createResourceOperation(
      type,
      resourceId,
      payload,
      this.nodeId,
      1, // version would be determined by resource registry
      this.localClock,
      correlationContext.correlationId
    );

    // Add metadata
    if (metadata) {
      operation.metadata = { ...metadata };
    }

    // Authorization check
    if (this.authorizationService && principal) {
      const authResult = await this.authorizationService.authorizeOperation(principal, operation);
      if (!authResult.allowed) {
        throw new Error(`Operation ${operation.opId} unauthorized: ${authResult.reason}`);
      }
    }

    // Deduplication check
    if (this.operationDeduplicator) {
      return this.operationDeduplicator.processOnce(operation, async (op) => {
        await this.executeOperation(op);
        return op;
      });
    } else {
      await this.executeOperation(operation);
      return operation;
    }
  }

  /**
   * Execute the actual operation
   */
  private async executeOperation<T>(operation: ResourceOperation<T>): Promise<void> {
    try {
      // Update local vector clock
      this.localClock.merge(operation.vectorClock);

      // Emit change event
      const changeEvent: ResourceChangeEvent<T> = {
        operation,
        resource: operation.payload,
        metadata: operation.metadata
      };
      this.emit('resourceChange', changeEvent);

      // Distribute to subscriptions
      if (this.subscriptionDeduplicator) {
        await this.subscriptionDeduplicator.deliverOperation(operation);
      }

    } catch (error) {
      this.emit('operationError', { operation, error });
      throw error;
    }
  }

  /**
   * Extract principal from operation metadata
   */
  private extractPrincipalFromOperation(operation: ResourceOperation): Principal | null {
    if (!operation.metadata?.principal) {
      return null;
    }

    return operation.metadata.principal as Principal;
  }

  /**
   * Compare two vector clocks
   */
  private compareVectorClocks(a: VectorClock, b: VectorClock): number {
    let aLessB = false;
    let bLessA = false;
    
    const allNodes = new Set([...a.vector.keys(), ...b.vector.keys()]);
    
    for (const nodeId of allNodes) {
      const aValue = a.vector.get(nodeId) || 0;
      const bValue = b.vector.get(nodeId) || 0;
      
      if (aValue < bValue) aLessB = true;
      else if (aValue > bValue) bLessA = true;
    }
    
    if (aLessB && !bLessA) return -1;
    if (bLessA && !aLessB) return 1;
    if (!aLessB && !bLessA) return 0;
    return NaN; // concurrent
  }

  /**
   * Merge two vector clocks
   */
  private mergeVectorClocks(a: VectorClock, b: VectorClock): VectorClock {
    const merged = new Map(a.vector);
    
    for (const [nodeId, timestamp] of b.vector.entries()) {
      const currentTimestamp = merged.get(nodeId) || 0;
      merged.set(nodeId, Math.max(currentTimestamp, timestamp));
    }
    
    return {
      nodeId: a.nodeId,
      vector: merged,
      increment: a.increment,
      compare: a.compare,
      merge: a.merge
    };
  }

  /**
   * Get the authorization service (if enabled)
   */
  getAuthorizationService(): ResourceAuthorizationService | undefined {
    return this.authorizationService;
  }

  /**
   * Get the current vector clock
   */
  getCurrentClock(): VectorClock {
    return {
      nodeId: this.localClock.nodeId,
      vector: new Map(this.localClock.vector),
      increment: this.localClock.increment,
      compare: this.localClock.compare,
      merge: this.localClock.merge
    };
  }
}
