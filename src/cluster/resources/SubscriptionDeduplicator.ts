import { ResourceOperation } from './ResourceOperation';

export interface SubscriptionDelivery {
  subscriptionId: string;
  operationId: string;
  deliveredAt: number;
  retryCount: number;
  lastAttempt: number;
}

export interface SubscriptionConfig {
  maxRetries: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
  deliveryTimeoutMs: number;
  cleanupIntervalMs: number;
  maxDeliveryHistory: number;
}

export interface Subscription<T = any> {
  id: string;
  nodeId: string;
  resourcePattern: string;
  operationTypes: string[];
  handler: (operation: ResourceOperation<T>) => Promise<void>;
  config: SubscriptionConfig;
}

export class SubscriptionDeduplicator {
  private readonly deliveryHistory = new Map<string, SubscriptionDelivery>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly pendingDeliveries = new Map<string, Promise<void>>();
  private readonly defaultConfig: SubscriptionConfig;
  private isShutdown = false;

  constructor(config: Partial<SubscriptionConfig> = {}) {
    this.defaultConfig = {
      maxRetries: config.maxRetries ?? 3,
      retryDelayMs: config.retryDelayMs ?? 1000,
      maxRetryDelayMs: config.maxRetryDelayMs ?? 30000,
      deliveryTimeoutMs: config.deliveryTimeoutMs ?? 60000,
      cleanupIntervalMs: config.cleanupIntervalMs ?? 300000, // 5 minutes
      maxDeliveryHistory: config.maxDeliveryHistory ?? 10000
    };

    this.startCleanupLoop();
  }

  /**
   * Register a subscription for resource operations
   */
  subscribe<T>(
    subscriptionId: string,
    nodeId: string,
    resourcePattern: string,
    operationTypes: string[],
    handler: (operation: ResourceOperation<T>) => Promise<void>,
    config?: Partial<SubscriptionConfig>
  ): void {
    const subscription: Subscription<T> = {
      id: subscriptionId,
      nodeId,
      resourcePattern,
      operationTypes,
      handler,
      config: { ...this.defaultConfig, ...config }
    };

    this.subscriptions.set(subscriptionId, subscription);
  }

  /**
   * Unsubscribe from resource operations
   */
  unsubscribe(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId);
    
    // Clean up delivery history for this subscription
    const toRemove: string[] = [];
    for (const [key, delivery] of this.deliveryHistory.entries()) {
      if (delivery.subscriptionId === subscriptionId) {
        toRemove.push(key);
      }
    }
    
    for (const key of toRemove) {
      this.deliveryHistory.delete(key);
    }
  }

  /**
   * Deliver an operation to all matching subscriptions with exactly-once semantics
   */
  async deliverOperation<T>(operation: ResourceOperation<T>): Promise<void> {
    const matchingSubscriptions = this.findMatchingSubscriptions(operation);
    const deliveryPromises: Promise<void>[] = [];

    for (const subscription of matchingSubscriptions) {
      const deliveryPromise = this.deliverToSubscription(operation, subscription);
      deliveryPromises.push(deliveryPromise);
    }

    // Wait for all deliveries to complete
    await Promise.allSettled(deliveryPromises);
  }

  /**
   * Find subscriptions that match an operation
   */
  private findMatchingSubscriptions<T>(operation: ResourceOperation<T>): Subscription[] {
    const matching: Subscription[] = [];

    for (const subscription of this.subscriptions.values()) {
      // Check operation type filter
      if (subscription.operationTypes.length > 0 && 
          !subscription.operationTypes.includes(operation.type)) {
        continue;
      }

      // Check resource pattern (simple glob-like matching)
      if (!this.matchesPattern(operation.resourceId, subscription.resourcePattern)) {
        continue;
      }

      matching.push(subscription);
    }

    return matching;
  }

  /**
   * Simple pattern matching for resource IDs
   */
  private matchesPattern(resourceId: string, pattern: string): boolean {
    // Convert glob-like pattern to regex
    const regexPattern = pattern
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
      .replace(/\[([^\]]+)\]/g, '[$1]');
    
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(resourceId);
  }

  /**
   * Deliver operation to a specific subscription with deduplication
   */
  private async deliverToSubscription<T>(
    operation: ResourceOperation<T>,
    subscription: Subscription<T>
  ): Promise<void> {
    const deliveryKey = `${subscription.id}:${operation.opId}`;

    // Check if already delivered
    const existing = this.deliveryHistory.get(deliveryKey);
    if (existing && this.isDeliveryComplete(existing)) {
      return;
    }

    // Check if delivery is already in progress
    const pendingDelivery = this.pendingDeliveries.get(deliveryKey);
    if (pendingDelivery) {
      return pendingDelivery;
    }

    // Start new delivery
    const deliveryPromise = this.executeDelivery(operation, subscription, deliveryKey);
    this.pendingDeliveries.set(deliveryKey, deliveryPromise);

    try {
      await deliveryPromise;
    } finally {
      this.pendingDeliveries.delete(deliveryKey);
    }
  }

  /**
   * Execute the actual delivery with retry logic
   */
  private async executeDelivery<T>(
    operation: ResourceOperation<T>,
    subscription: Subscription<T>,
    deliveryKey: string
  ): Promise<void> {
    const delivery: SubscriptionDelivery = {
      subscriptionId: subscription.id,
      operationId: operation.opId,
      deliveredAt: 0,
      retryCount: 0,
      lastAttempt: Date.now()
    };

    this.deliveryHistory.set(deliveryKey, delivery);

    while (delivery.retryCount <= subscription.config.maxRetries) {
      try {
        // Attempt delivery
        await this.attemptDelivery(operation, subscription, delivery);
        
        // Mark as successfully delivered
        delivery.deliveredAt = Date.now();
        return;
        
      } catch (error) {
        delivery.retryCount++;
        delivery.lastAttempt = Date.now();

        if (delivery.retryCount > subscription.config.maxRetries) {
          throw new Error(
            `Failed to deliver operation ${operation.opId} to subscription ${subscription.id} after ${delivery.retryCount} attempts: ${error}`
          );
        }

        // Calculate exponential backoff delay
        const baseDelay = subscription.config.retryDelayMs;
        const exponentialDelay = baseDelay * Math.pow(2, delivery.retryCount - 1);
        const delay = Math.min(exponentialDelay, subscription.config.maxRetryDelayMs);
        
        await this.sleep(delay);
      }
    }
  }

  /**
   * Attempt to deliver operation to subscription handler
   */
  private async attemptDelivery<T>(
    operation: ResourceOperation<T>,
    subscription: Subscription<T>,
    delivery: SubscriptionDelivery
  ): Promise<void> {
    const startTime = Date.now();
    
    // Create a timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      this.sleep(subscription.config.deliveryTimeoutMs).then(() => {
        reject(new Error(`Delivery timeout after ${subscription.config.deliveryTimeoutMs}ms`));
      });
    });

    // Race between handler execution and timeout
    await Promise.race([
      subscription.handler(operation),
      timeoutPromise
    ]);

    const duration = Date.now() - startTime;
    
    // Successfully delivered (logging would be handled by external logger)
  }

  /**
   * Check if a delivery is complete (successfully delivered)
   */
  private isDeliveryComplete(delivery: SubscriptionDelivery): boolean {
    return delivery.deliveredAt > 0;
  }

  /**
   * Start cleanup loop for old delivery history
   */
  private startCleanupLoop(): void {
    const cleanup = async () => {
      while (!this.isShutdown) {
        await this.sleep(this.defaultConfig.cleanupIntervalMs);
        if (!this.isShutdown) {
          this.cleanupDeliveryHistory();
        }
      }
    };
    
    cleanup().catch(() => {
      // Ignore cleanup errors
    });
  }

  /**
   * Clean up old delivery history to prevent memory leaks
   */
  private cleanupDeliveryHistory(): void {
    if (this.deliveryHistory.size <= this.defaultConfig.maxDeliveryHistory) {
      return;
    }

    // Convert to array and sort by last attempt time
    const deliveries = Array.from(this.deliveryHistory.entries())
      .sort(([, a], [, b]) => a.lastAttempt - b.lastAttempt);

    // Remove oldest entries
    const toRemove = deliveries.slice(0, this.deliveryHistory.size - this.defaultConfig.maxDeliveryHistory);
    for (const [key] of toRemove) {
      this.deliveryHistory.delete(key);
    }
  }

  /**
   * Sleep utility for async waiting
   */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const timer = Date.now() + ms;
      const check = () => {
        if (Date.now() >= timer) {
          resolve();
        } else {
          Promise.resolve().then(check);
        }
      };
      check();
    });
  }

  /**
   * Get subscription and delivery statistics
   */
  getStats() {
    const deliveries = Array.from(this.deliveryHistory.values());
    const successful = deliveries.filter(d => this.isDeliveryComplete(d)).length;
    const failed = deliveries.filter(d => d.retryCount > 0 && !this.isDeliveryComplete(d)).length;
    const pending = this.pendingDeliveries.size;

    const retryStats = deliveries.reduce((acc, d) => {
      acc.totalRetries += d.retryCount;
      acc.maxRetries = Math.max(acc.maxRetries, d.retryCount);
      return acc;
    }, { totalRetries: 0, maxRetries: 0 });

    return {
      subscriptions: this.subscriptions.size,
      deliveryHistory: this.deliveryHistory.size,
      pendingDeliveries: pending,
      successfulDeliveries: successful,
      failedDeliveries: failed,
      averageRetries: deliveries.length > 0 ? retryStats.totalRetries / deliveries.length : 0,
      maxRetries: retryStats.maxRetries
    };
  }

  /**
   * Get information about a specific subscription
   */
  getSubscriptionInfo(subscriptionId: string): Subscription | null {
    return this.subscriptions.get(subscriptionId) || null;
  }

  /**
   * List all active subscriptions
   */
  listSubscriptions(): Subscription[] {
    return Array.from(this.subscriptions.values());
  }

  /**
   * Shutdown the subscription deduplicator
   */
  shutdown(): void {
    this.isShutdown = true;
    this.subscriptions.clear();
    this.deliveryHistory.clear();
    this.pendingDeliveries.clear();
  }
}
