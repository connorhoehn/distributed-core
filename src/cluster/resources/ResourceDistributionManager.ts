import { EventEmitter } from 'events';
import { ClusterManager } from '../ClusterManager';
import { ResourceRegistry } from '../../resources/core/ResourceRegistry';
import { ResourceMetadata } from '../../resources/types';

/**
 * Resource Distribution Manager - Missing component for multi-node resource coordination
 * 
 * This class handles the distribution of ephemeral resources (like messages) across
 * multiple nodes that are hosting the same logical resource (like a chat room).
 */
export class ResourceDistributionManager extends EventEmitter {
  private clusterManager: ClusterManager;
  private resourceRegistry: ResourceRegistry;
  private nodeId: string;
  
  // Track which nodes are hosting which resources
  private resourceHostingMap = new Map<string, Set<string>>(); // resourceId -> Set<nodeId>
  private nodeResourceMap = new Map<string, Set<string>>(); // nodeId -> Set<resourceId>

  constructor(
    nodeId: string, 
    clusterManager: ClusterManager, 
    resourceRegistry: ResourceRegistry
  ) {
    super();
    this.nodeId = nodeId;
    this.clusterManager = clusterManager;
    this.resourceRegistry = resourceRegistry;
    
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Listen for cluster messages about resource distribution
    this.clusterManager.on('message', (message: any) => {
      if (message.type === 'custom' && message.data?.customType === 'RESOURCE_DISTRIBUTION') {
        this.handleResourceDistributionMessage(message);
      }
    });

    // Listen for local resource creation and distribute to hosting nodes
    this.resourceRegistry.on('resource:created', async (resource: ResourceMetadata) => {
      await this.distributeResourceToHostingNodes(resource);
    });
  }

  /**
   * Register that a node is hosting a specific resource type/pattern
   */
  async registerResourceHosting(resourcePattern: string, nodeIds: string[]): Promise<void> {
    for (const nodeId of nodeIds) {
      if (!this.nodeResourceMap.has(nodeId)) {
        this.nodeResourceMap.set(nodeId, new Set());
      }
      this.nodeResourceMap.get(nodeId)!.add(resourcePattern);

      if (!this.resourceHostingMap.has(resourcePattern)) {
        this.resourceHostingMap.set(resourcePattern, new Set());
      }
      this.resourceHostingMap.get(resourcePattern)!.add(nodeId);
    }
    
    console.log(`📍 [ResourceDistribution] Node ${this.nodeId} registered hosting for ${resourcePattern} on nodes: ${nodeIds.join(', ')}`);
  }

  /**
   * Distribute a resource to all nodes that should be hosting it
   */
  private async distributeResourceToHostingNodes(resource: ResourceMetadata): Promise<void> {
    // For ephemeral message resources, find the parent room and distribute to all room-hosting nodes
    if (resource.resourceType === 'ephemeral-message' && resource.applicationData?.roomId) {
      const roomId = resource.applicationData.roomId;
      const hostingNodes = this.getHostingNodesForResource(roomId);
      
      if (hostingNodes.size > 0) {
        await this.broadcastResourceToNodes(resource, Array.from(hostingNodes));
      }
    }
  }

  /**
   * Get all nodes that should be hosting a specific resource
   */
  private getHostingNodesForResource(resourceId: string): Set<string> {
    // Check exact matches first
    if (this.resourceHostingMap.has(resourceId)) {
      return this.resourceHostingMap.get(resourceId)!;
    }

    // Check pattern matches (e.g., room-* patterns)
    const hostingNodes = new Set<string>();
    for (const [pattern, nodes] of this.resourceHostingMap.entries()) {
      if (this.matchesPattern(resourceId, pattern)) {
        nodes.forEach(node => hostingNodes.add(node));
      }
    }

    return hostingNodes;
  }

  /**
   * Simple pattern matching for resource hosting
   */
  private matchesPattern(resourceId: string, pattern: string): boolean {
    if (pattern.includes('*')) {
      const regex = new RegExp(pattern.replace(/\\*/g, '.*'));
      return regex.test(resourceId);
    }
    return resourceId === pattern;
  }

  /**
   * Broadcast a resource to specific nodes in the cluster
   */
  private async broadcastResourceToNodes(resource: ResourceMetadata, targetNodes: string[]): Promise<void> {
    const otherNodes = targetNodes.filter(nodeId => nodeId !== this.nodeId);
    
    if (otherNodes.length === 0) {
      return;
    }

    const payload = {
      action: 'CREATE_RESOURCE',
      resource: resource,
      sourceNode: this.nodeId,
      targetNodes: otherNodes
    };

    try {
      await this.clusterManager.sendCustomMessage('RESOURCE_DISTRIBUTION', payload, otherNodes);
      console.log(`📡 [ResourceDistribution] Distributed ${resource.resourceType} ${resource.resourceId} to ${otherNodes.length} nodes`);
    } catch (error) {
      console.error(`❌ [ResourceDistribution] Failed to distribute resource:`, error);
    }
  }

  /**
   * Handle incoming resource distribution messages
   */
  private async handleResourceDistributionMessage(message: any): Promise<void> {
    const payload = message.data.payload;
    
    if (payload.action === 'CREATE_RESOURCE') {
      const resource = payload.resource;
      
      // Emit the resource:created event locally to trigger logging
      this.resourceRegistry.emit('resource:created', resource);
      
      console.log(`📥 [ResourceDistribution] Received distributed resource ${resource.resourceType} ${resource.resourceId} from ${payload.sourceNode}`);
    }
  }

  /**
   * Public API: Set up room hosting for distributed rooms
   */
  async setupRoomHosting(roomId: string): Promise<void> {
    // Get all cluster members to host the room
    const clusterMembers = this.clusterManager.membership.getAllMembers();
    const nodeIds = clusterMembers
      .filter(member => member.status === 'ALIVE')
      .map(member => member.id);

    await this.registerResourceHosting(roomId, nodeIds);
    
    // Also register for message patterns for this room
    await this.registerResourceHosting(`message:${roomId}:*`, nodeIds);
  }
}
