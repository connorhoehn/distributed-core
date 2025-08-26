/**
 * ResourceCoordinator - High-level resource management abstraction
 * 
 * Hides the complexity of:
 * - Resource registry management
 * - Resource attachment and subscription tracking
 * - Resource distribution across the cluster
 * - Resource lifecycle and monitoring
 * 
 * Provides simple interface for:
 * - Creating/updating/deleting resources
 * - Subscribing clients to resources
 * - Querying resource state
 * - Resource health and metrics
 */

import { ResourceManager } from '../resources/management/ResourceManager';
import { ResourceAttachmentService } from '../resources/attachment/ResourceAttachmentService';
import { ResourceDistributionEngine } from '../resources/distribution/ResourceDistributionEngine';
import { ResourceRegistry } from '../resources/core/ResourceRegistry';
import { ClusterFanoutRouter } from '../resources/distribution/ClusterFanoutRouter';
import { ResourceOperation } from '../resources/core/ResourceOperation';

export interface ResourceCoordinatorConfig {
  nodeId: string;
  enableAttachment?: boolean;
  enableDistribution?: boolean;
  enableRouting?: boolean;
}

export interface ResourceInfo {
  id: string;
  type: string;
  size: number;
  version: number;
  lastModified: number;
  subscriberCount: number;
  nodeId: string;
  metadata?: Record<string, any>;
}

export interface ResourceMetrics {
  totalResources: number;
  activeSubscriptions: number;
  operationsPerSecond: number;
  averageLatency: number;
  errorRate: number;
}

/**
 * High-level resource management abstraction
 * Hides registry, attachment, distribution complexity
 */
export class ResourceCoordinator {
  private resourceManager: ResourceManager;
  private attachmentService?: ResourceAttachmentService;
  private distributionEngine?: ResourceDistributionEngine;
  private fanoutRouter?: ClusterFanoutRouter;
  private isStarted: boolean = false;

  constructor(
    resourceManager: ResourceManager,
    attachmentService?: ResourceAttachmentService,
    distributionEngine?: ResourceDistributionEngine,
    fanoutRouter?: ClusterFanoutRouter
  ) {
    this.resourceManager = resourceManager;
    this.attachmentService = attachmentService;
    this.distributionEngine = distributionEngine;
    this.fanoutRouter = fanoutRouter;
  }

  /**
   * Start resource coordination
   */
  async start(): Promise<void> {
    if (this.isStarted) return;

    await this.resourceManager.start();
    this.isStarted = true;
  }

  /**
   * Stop resource coordination
   */
  async stop(): Promise<void> {
    if (!this.isStarted) return;

    await this.resourceManager.stop();
    this.isStarted = false;
  }

  /**
   * Create a new resource
   */
  async createResource(
    resourceId: string,
    data: any,
    metadata?: Record<string, any>
  ): Promise<void> {
    const registry = (this.resourceManager as any).resourceRegistry as ResourceRegistry;
    await registry.createResource({ resourceId, ...data, metadata });
  }

  /**
   * Update an existing resource
   */
  async updateResource(
    resourceId: string,
    updates: any,
    metadata?: Record<string, any>
  ): Promise<void> {
    const registry = (this.resourceManager as any).resourceRegistry as ResourceRegistry;
    await registry.updateResource(resourceId, { ...updates, metadata });
  }

  /**
   * Delete a resource
   */
  async deleteResource(resourceId: string): Promise<void> {
    const registry = (this.resourceManager as any).resourceRegistry as ResourceRegistry;
    await registry.destroyResource(resourceId);
  }

  /**
   * Get resource information
   */
  async getResource(resourceId: string): Promise<ResourceInfo | null> {
    const registry = (this.resourceManager as any).resourceRegistry as ResourceRegistry;
    const resource = await registry.getResource(resourceId);
    
    if (!resource) return null;

    const subscriberCount = this.attachmentService 
      ? (await this.attachmentService.members(resourceId)).size
      : 0;

    return {
      id: resourceId,
      type: resource.type || 'unknown',
      size: JSON.stringify(resource).length,
      version: resource.version || 1,
      lastModified: typeof resource.lastModified === 'number'
        ? resource.lastModified
        : resource.lastModified instanceof Date
          ? resource.lastModified.getTime()
          : Date.now(),
      subscriberCount,
      nodeId: resource.nodeId || 'unknown',
      metadata: resource.metadata
    };
  }

  /**
   * Subscribe a client to a resource
   */
  async subscribe(
    connectionId: string,
    resourceId: string,
    filters?: any
  ): Promise<void> {
    if (!this.attachmentService) {
      throw new Error('Attachment service not enabled');
    }
    await this.attachmentService.attach(connectionId, resourceId, filters);
  }

  /**
   * Unsubscribe a client from a resource
   */
  async unsubscribe(connectionId: string, resourceId: string): Promise<void> {
    if (!this.attachmentService) {
      throw new Error('Attachment service not enabled');
    }
    await this.attachmentService.detach(connectionId, resourceId);
  }

  /**
   * Get all subscribers for a resource
   */
  async getSubscribers(resourceId: string): Promise<string[]> {
    if (!this.attachmentService) return [];
    const members = await this.attachmentService.members(resourceId);
    return Array.from(members);
  }

  /**
   * List all resources
   */
  async listResources(filter?: string): Promise<ResourceInfo[]> {
    const registry = (this.resourceManager as any).resourceRegistry as ResourceRegistry;
    const allResources = await registry.listResources();
    
    const resourceInfos: ResourceInfo[] = [];
    for (const resource of allResources) {
      const resourceId = typeof resource === 'string' ? resource : resource.id;
      const info = await this.getResource(resourceId);
      if (info && (!filter || info.type.includes(filter))) {
        resourceInfos.push(info);
      }
    }
    
    return resourceInfos;
  }

  /**
   * Get resource metrics
   */
  async getMetrics(): Promise<ResourceMetrics> {
    const resources = await this.listResources();
    const totalSubscriptions = resources.reduce((sum, r) => sum + r.subscriberCount, 0);

    return {
      totalResources: resources.length,
      activeSubscriptions: totalSubscriptions,
      operationsPerSecond: 0, // TODO: implement metrics tracking
      averageLatency: 0, // TODO: implement latency tracking
      errorRate: 0 // TODO: implement error rate tracking
    };
  }

  /**
   * Process incoming resource operation
   */
  async processOperation(operation: ResourceOperation): Promise<void> {
    if (this.distributionEngine) {
      await this.distributionEngine.processIncomingOperation(operation);
    }
  }

  /**
   * Route operation to appropriate nodes
   */
  async routeOperation(
    resourceId: string,
    operation: ResourceOperation
  ): Promise<string[]> {
    if (!this.fanoutRouter) return [];
    
    const routes = await this.fanoutRouter.route(resourceId, {
      preferPrimary: true,
      replicationFactor: 2,
      useGossipFallback: true
    });
    
    return routes.map(route => route.nodeId);
  }

  /**
   * Check if resource coordinator is ready
   */
  isReady(): boolean {
    return this.isStarted;
  }
}
