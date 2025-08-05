/**
 * Core type definitions for the generic resource management system
 */

export interface ResourceMetadata {
  resourceId: string;
  resourceType: string;
  nodeId: string;
  timestamp: number;
  
  // Generic capacity metrics that can apply to any resource type
  capacity: {
    current: number;
    maximum: number;
    unit: string; // e.g., 'connections', 'tasks', 'data_mb', 'participants'
  };
  
  // Performance metrics
  performance: {
    latency: number; // average operation latency in ms
    throughput: number; // operations per second
    errorRate: number; // percentage
  };
  
  // Distribution metadata
  distribution: {
    shardCount?: number;
    partitionKey?: string;
    replicationFactor?: number;
    preferredNodes?: string[];
  };
  
  // Application-specific data (can be extended by implementations)
  applicationData: Record<string, any>;
  
  // Resource state
  state: ResourceState;
  health: ResourceHealth;
}

export interface ResourceCapacity {
  nodeId: string;
  resourceType: string;
  
  // Node-level capacity for this resource type
  totalCapacity: number;
  availableCapacity: number;
  reservedCapacity: number;
  
  // Performance characteristics
  maxThroughput: number;
  avgLatency: number;
  
  // Resource-specific constraints
  constraints: {
    memoryLimitMB?: number;
    cpuLimitPercent?: number;
    networkBandwidthMbps?: number;
    storageGB?: number;
    maxConcurrentOperations?: number;
  };
  
  // Cost metrics for placement decisions
  cost: {
    computeCost: number;
    networkCost: number;
    storageCost: number;
  };
}

export interface ResourceDistribution {
  resourceId: string;
  resourceType: string;
  
  // Current distribution across cluster
  nodeAssignments: Map<string, ResourceAssignment>;
  
  // Distribution strategy
  strategy: DistributionStrategy;
  
  // Optimization metrics
  balanceScore: number; // 0-100, higher is better balanced
  hotspotRisk: number; // 0-100, higher means more risk
  migrationCost: number; // estimated cost to rebalance
  
  // Placement recommendations
  recommendations: PlacementRecommendation[];
}

export interface ResourceAssignment {
  nodeId: string;
  resourceId: string;
  
  // Assignment details
  assignedCapacity: number;
  utilization: number; // 0-1
  priority: number; // higher numbers get priority during contention
  
  // Performance tracking
  avgLatency: number;
  throughput: number;
  errorCount: number;
  
  // Assignment metadata
  assignedAt: number;
  lastHealthCheck: number;
  migrationHistory: MigrationRecord[];
}

export interface PlacementRecommendation {
  resourceId: string;
  recommendationType: 'CREATE' | 'MIGRATE' | 'SCALE' | 'REMOVE';
  targetNodeId: string;
  sourceNodeId?: string;
  
  reasoning: string;
  priority: number;
  estimatedBenefit: number;
  estimatedCost: number;
  
  // Execution details
  canExecuteImmediately: boolean;
  prerequisites: string[];
  rollbackPlan?: string;
}

export interface MigrationRecord {
  fromNodeId: string;
  toNodeId: string;
  timestamp: number;
  reason: string;
  migrationTimeMs: number;
  success: boolean;
}

export enum ResourceState {
  INITIALIZING = 'INITIALIZING',
  ACTIVE = 'ACTIVE',
  SCALING = 'SCALING',
  MIGRATING = 'MIGRATING',
  DRAINING = 'DRAINING',
  SUSPENDED = 'SUSPENDED',
  TERMINATING = 'TERMINATING',
  ERROR = 'ERROR'
}

export enum ResourceHealth {
  HEALTHY = 'HEALTHY',
  DEGRADED = 'DEGRADED',
  UNHEALTHY = 'UNHEALTHY',
  UNKNOWN = 'UNKNOWN'
}

export enum DistributionStrategy {
  ROUND_ROBIN = 'ROUND_ROBIN',
  LEAST_LOADED = 'LEAST_LOADED',
  CONSISTENT_HASH = 'CONSISTENT_HASH',
  AFFINITY_BASED = 'AFFINITY_BASED',
  COST_OPTIMIZED = 'COST_OPTIMIZED',
  LATENCY_OPTIMIZED = 'LATENCY_OPTIMIZED'
}

// Resource type definition for the registry
export interface ResourceTypeDefinition {
  typeName: string;
  version: string;
  
  // Capacity planning
  defaultCapacity: Partial<ResourceCapacity>;
  capacityCalculator: (metadata: any) => number;
  
  // Health and performance
  healthChecker: (resource: ResourceMetadata) => ResourceHealth;
  performanceMetrics: string[]; // list of metric names this resource type tracks
  
  // Distribution preferences
  defaultDistributionStrategy: DistributionStrategy;
  distributionConstraints: DistributionConstraint[];
  
  // Lifecycle hooks
  onResourceCreated?: (resource: ResourceMetadata) => Promise<void>;
  onResourceDestroyed?: (resource: ResourceMetadata) => Promise<void>;
  onResourceMigrated?: (resource: ResourceMetadata, fromNode: string, toNode: string) => Promise<void>;
  
  // Serialization
  serialize: (resource: ResourceMetadata) => any;
  deserialize: (data: any) => ResourceMetadata;
}

export interface DistributionConstraint {
  name: string;
  validator: (resource: ResourceMetadata, targetNode: string, cluster: any) => boolean;
  weight: number; // how important this constraint is (0-1)
  description: string;
}

// Events that can be emitted by the resource system
export interface ResourceEvent {
  eventType: ResourceEventType;
  resourceId: string;
  resourceType: string;
  nodeId: string;
  timestamp: number;
  metadata: Record<string, any>;
}

export enum ResourceEventType {
  RESOURCE_CREATED = 'RESOURCE_CREATED',
  RESOURCE_UPDATED = 'RESOURCE_UPDATED',
  RESOURCE_DESTROYED = 'RESOURCE_DESTROYED',
  RESOURCE_MIGRATED = 'RESOURCE_MIGRATED',
  RESOURCE_SCALED = 'RESOURCE_SCALED',
  RESOURCE_HEALTH_CHANGED = 'RESOURCE_HEALTH_CHANGED',
  CAPACITY_THRESHOLD_EXCEEDED = 'CAPACITY_THRESHOLD_EXCEEDED',
  DISTRIBUTION_IMBALANCED = 'DISTRIBUTION_IMBALANCED'
}
