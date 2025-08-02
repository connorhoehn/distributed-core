import { EventEmitter } from 'events';
import { ClusterManager } from '../ClusterManager';
import { ClusterState, LogicalService, PerformanceMetrics } from '../introspection/ClusterIntrospection';
import { ClusterHealth, ClusterTopology, ClusterMetadata } from '../types';
import { Message, MessageType } from '../../types';

/**
 * Aggregated cluster state from multiple nodes
 */
export interface AggregatedClusterState {
  clusterHealth: ClusterHealth;
  nodeStates: Map<string, ClusterState>;
  aggregatedServices: LogicalService[];
  aggregatedMetrics: PerformanceMetrics;
  consistencyScore: number;
  partitionInfo: PartitionInfo;
  timestamp: number;
}

/**
 * Information about network partitions
 */
export interface PartitionInfo {
  isPartitioned: boolean;
  partitionCount: number;
  largestPartitionSize: number;
  unreachableNodes: string[];
  lastPartitionDetected?: number;
}

/**
 * Configuration for state aggregation
 */
export interface StateAggregatorConfig {
  collectionTimeout: number; // milliseconds to wait for responses
  minQuorumSize: number; // minimum nodes needed for consistent view
  enableConsistencyChecks: boolean;
  maxStaleTime: number; // maximum age of data to consider fresh
  aggregationInterval: number; // how often to collect state
}

/**
 * StateAggregator collects and aggregates cluster state from multiple nodes
 * for external monitoring systems and dashboards
 */
export class StateAggregator extends EventEmitter {
  private clusterManager: ClusterManager;
  private config: StateAggregatorConfig;
  private lastAggregatedState?: AggregatedClusterState;
  private aggregationTimer?: NodeJS.Timeout;
  private pendingCollections = new Map<string, {
    resolve: (state: ClusterState) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(
    clusterManager: ClusterManager,
    config: Partial<StateAggregatorConfig> = {}
  ) {
    super();
    this.clusterManager = clusterManager;
    this.config = {
      collectionTimeout: 5000,
      minQuorumSize: Math.ceil(clusterManager.getMemberCount() / 2),
      enableConsistencyChecks: true,
      maxStaleTime: 30000,
      aggregationInterval: 10000,
      ...config
    };

    this.setupMessageHandling();
  }

  /**
   * Start automatic state aggregation
   */
  start(): void {
    this.aggregationTimer = setInterval(() => {
      this.collectClusterState().catch(error => {
        this.emit('aggregation-error', error);
      });
    }, this.config.aggregationInterval);

    this.emit('started');
  }

  /**
   * Stop automatic state aggregation
   */
  stop(): void {
    if (this.aggregationTimer) {
      clearInterval(this.aggregationTimer);
      this.aggregationTimer = undefined;
    }

    // Cancel pending collections
    for (const [messageId, pending] of this.pendingCollections) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('StateAggregator stopped'));
    }
    this.pendingCollections.clear();

    this.emit('stopped');
  }

  /**
   * Collect current cluster state from all reachable nodes
   */
  async collectClusterState(): Promise<AggregatedClusterState> {
    const aliveMembers = this.clusterManager.getMembership();
    const nodeStates = new Map<string, ClusterState>();
    const localState = this.clusterManager.getIntrospection().getCurrentState();
    
    // Always include local state
    nodeStates.set(this.clusterManager.getNodeInfo().id, localState);

    // Collect state from remote nodes
    const remoteCollections = Array.from(aliveMembers.entries())
      .filter(([nodeId]) => nodeId !== this.clusterManager.getNodeInfo().id)
      .map(async ([nodeId, member]) => {
        try {
          const remoteState = await this.collectFromNode(nodeId);
          nodeStates.set(nodeId, remoteState);
        } catch (error) {
          this.emit('node-collection-failed', { nodeId, error });
        }
      });

    await Promise.allSettled(remoteCollections);

    // Aggregate the collected states
    const aggregatedState = this.aggregateStates(nodeStates);
    
    this.lastAggregatedState = aggregatedState;
    this.emit('state-aggregated', aggregatedState);
    
    return aggregatedState;
  }

  /**
   * Get the last aggregated cluster state
   */
  getLastAggregatedState(): AggregatedClusterState | undefined {
    return this.lastAggregatedState;
  }

  /**
   * Enforce consistency by collecting from a quorum of nodes
   */
  async getConsistentView(): Promise<AggregatedClusterState> {
    const state = await this.collectClusterState();
    
    if (!this.config.enableConsistencyChecks) {
      return state;
    }

    const nodeCount = state.nodeStates.size;
    const requiredQuorum = Math.max(this.config.minQuorumSize, Math.ceil(nodeCount / 2));

    if (nodeCount < requiredQuorum) {
      throw new Error(`Insufficient nodes for consistent view: ${nodeCount} < ${requiredQuorum}`);
    }

    if (state.consistencyScore < 0.8) {
      throw new Error(`Cluster state inconsistency detected: score ${state.consistencyScore}`);
    }

    return state;
  }

  /**
   * Detect network partitions
   */
  detectPartitions(): PartitionInfo {
    if (!this.lastAggregatedState) {
      return {
        isPartitioned: false,
        partitionCount: 1,
        largestPartitionSize: this.clusterManager.getMemberCount(),
        unreachableNodes: []
      };
    }

    const totalMembers = this.clusterManager.getMemberCount();
    const reachableNodes = this.lastAggregatedState.nodeStates.size;
    const unreachableNodes = Array.from(this.clusterManager.getMembership().keys())
      .filter(nodeId => !this.lastAggregatedState!.nodeStates.has(nodeId));

    const isPartitioned = unreachableNodes.length > 0;

    return {
      isPartitioned,
      partitionCount: isPartitioned ? 2 : 1, // Simplified partition detection
      largestPartitionSize: reachableNodes,
      unreachableNodes,
      lastPartitionDetected: isPartitioned ? Date.now() : undefined
    };
  }

  /**
   * Check if current data is stale
   */
  isStale(): boolean {
    if (!this.lastAggregatedState) {
      return true;
    }
    return Date.now() - this.lastAggregatedState.timestamp > this.config.maxStaleTime;
  }

  /**
   * Refresh data from quorum if stale
   */
  async refreshIfStale(): Promise<AggregatedClusterState> {
    if (this.isStale()) {
      return await this.getConsistentView();
    }
    return this.lastAggregatedState!;
  }

  /**
   * Collect state from a specific node
   */
  private async collectFromNode(nodeId: string): Promise<ClusterState> {
    return new Promise<ClusterState>((resolve, reject) => {
      const messageId = `state-request-${Date.now()}-${Math.random()}`;
      
      const timeout = setTimeout(() => {
        this.pendingCollections.delete(messageId);
        reject(new Error(`Timeout collecting state from node ${nodeId}`));
      }, this.config.collectionTimeout);

      this.pendingCollections.set(messageId, { resolve, reject, timeout });

      // Send state collection request
      const message: Message = {
        id: messageId,
        type: MessageType.CLUSTER_STATE_REQUEST,
        data: { requestType: 'full-state' },
        sender: { 
          id: this.clusterManager.getNodeInfo().id,
          address: 'localhost', // TODO: Get actual address
          port: 8080 // TODO: Get actual port
        },
        timestamp: Date.now()
      };

      this.clusterManager.transport.send(message, { id: nodeId, address: 'localhost', port: 8080 });
    });
  }

  /**
   * Setup message handling for state collection responses
   */
  private setupMessageHandling(): void {
    this.clusterManager.transport.onMessage((message: Message) => {
      if (message.type === MessageType.CLUSTER_STATE_RESPONSE) {
        this.handleStateResponse(message);
      } else if (message.type === MessageType.CLUSTER_STATE_REQUEST) {
        this.handleStateRequest(message);
      }
    });
  }

  /**
   * Handle incoming state collection requests
   */
  private handleStateRequest(message: Message): void {
    const localState = this.clusterManager.getIntrospection().getCurrentState();
    
    const response: Message = {
      id: `state-response-${message.id}`,
      type: MessageType.CLUSTER_STATE_RESPONSE,
      data: {
        originalRequestId: message.id,
        state: localState
      },
      sender: { 
        id: this.clusterManager.getNodeInfo().id,
        address: 'localhost', // TODO: Get actual address
        port: 8080 // TODO: Get actual port
      },
      timestamp: Date.now()
    };

    this.clusterManager.transport.send(response, message.sender);
  }

  /**
   * Handle state collection responses
   */
  private handleStateResponse(message: Message): void {
    const { originalRequestId, state } = message.data;
    const pending = this.pendingCollections.get(originalRequestId);
    
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingCollections.delete(originalRequestId);
      pending.resolve(state);
    }
  }

  /**
   * Aggregate multiple node states into a unified view
   */
  private aggregateStates(nodeStates: Map<string, ClusterState>): AggregatedClusterState {
    if (nodeStates.size === 0) {
      throw new Error('No node states to aggregate');
    }

    // Aggregate health metrics
    const healthMetrics = Array.from(nodeStates.values()).map(state => state.health);
    const clusterHealth = this.aggregateHealth(healthMetrics);

    // Aggregate logical services
    const allServices = Array.from(nodeStates.values())
      .flatMap(state => state.logicalServices);
    const aggregatedServices = this.deduplicateServices(allServices);

    // Aggregate performance metrics
    const performanceMetrics = Array.from(nodeStates.values()).map(state => state.performance);
    const aggregatedMetrics = this.aggregatePerformance(performanceMetrics);

    // Calculate consistency score
    const consistencyScore = this.calculateConsistencyScore(nodeStates);

    // Detect partitions
    const partitionInfo = this.detectPartitions();

    return {
      clusterHealth,
      nodeStates,
      aggregatedServices,
      aggregatedMetrics,
      consistencyScore,
      partitionInfo,
      timestamp: Date.now()
    };
  }

  /**
   * Aggregate health metrics from multiple nodes
   */
  private aggregateHealth(healthMetrics: ClusterHealth[]): ClusterHealth {
    if (healthMetrics.length === 0) {
      throw new Error('No health metrics to aggregate');
    }

    // Use the most recent/accurate health data
    const totalNodes = Math.max(...healthMetrics.map(h => h.totalNodes));
    const aliveNodes = Math.max(...healthMetrics.map(h => h.aliveNodes));
    const suspectNodes = Math.max(...healthMetrics.map(h => h.suspectNodes));
    const deadNodes = Math.max(...healthMetrics.map(h => h.deadNodes));

    return {
      totalNodes,
      aliveNodes,
      suspectNodes,
      deadNodes,
      healthRatio: totalNodes > 0 ? aliveNodes / totalNodes : 0,
      isHealthy: aliveNodes >= Math.ceil(totalNodes * 0.5),
      ringCoverage: Math.min(...healthMetrics.map(h => h.ringCoverage)),
      partitionCount: Math.max(...healthMetrics.map(h => h.partitionCount))
    };
  }

  /**
   * Deduplicate logical services from multiple nodes
   */
  private deduplicateServices(services: LogicalService[]): LogicalService[] {
    const serviceMap = new Map<string, LogicalService>();
    
    for (const service of services) {
      const existing = serviceMap.get(service.id);
      if (!existing || service.lastUpdated > existing.lastUpdated) {
        serviceMap.set(service.id, service);
      }
    }
    
    return Array.from(serviceMap.values());
  }

  /**
   * Aggregate performance metrics from multiple nodes
   */
  private aggregatePerformance(metrics: PerformanceMetrics[]): PerformanceMetrics {
    if (metrics.length === 0) {
      throw new Error('No performance metrics to aggregate');
    }

    const count = metrics.length;
    
    return {
      membershipSize: Math.max(...metrics.map(m => m.membershipSize)),
      gossipRate: metrics.reduce((sum, m) => sum + m.gossipRate, 0) / count,
      failureDetectionLatency: metrics.reduce((sum, m) => sum + m.failureDetectionLatency, 0) / count,
      averageHeartbeatInterval: metrics.reduce((sum, m) => sum + m.averageHeartbeatInterval, 0) / count,
      messageRate: metrics.reduce((sum, m) => sum + m.messageRate, 0),
      messageLatency: metrics.reduce((sum, m) => sum + m.messageLatency, 0) / count,
      networkThroughput: metrics.reduce((sum, m) => sum + m.networkThroughput, 0),
      timestamp: Math.max(...metrics.map(m => m.timestamp))
    };
  }

  /**
   * Calculate consistency score across node states
   */
  private calculateConsistencyScore(nodeStates: Map<string, ClusterState>): number {
    if (nodeStates.size <= 1) {
      return 1.0;
    }

    const states = Array.from(nodeStates.values());
    let consistencyPoints = 0;
    let totalChecks = 0;

    // Check membership consistency
    const membershipSizes = states.map(s => s.health.totalNodes);
    const avgMembershipSize = membershipSizes.reduce((sum, size) => sum + size, 0) / membershipSizes.length;
    
    for (const size of membershipSizes) {
      totalChecks++;
      if (Math.abs(size - avgMembershipSize) <= 1) { // Allow for slight variations
        consistencyPoints++;
      }
    }

    // Check service consistency (services should be unique across nodes)
    const allServiceIds = new Set<string>();
    const duplicateServices = new Set<string>();
    
    for (const state of states) {
      for (const service of state.logicalServices) {
        if (allServiceIds.has(service.id)) {
          duplicateServices.add(service.id);
        }
        allServiceIds.add(service.id);
      }
    }

    totalChecks++;
    if (duplicateServices.size === 0) {
      consistencyPoints++;
    }

    return totalChecks > 0 ? consistencyPoints / totalChecks : 1.0;
  }
}
