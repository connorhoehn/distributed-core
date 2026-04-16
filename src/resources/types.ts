export interface ResourceMetadata {
  id: string;
  resourceId: string; // Add missing resourceId
  type: string;
  resourceType: string; // Add missing resourceType
  version: number;
  createdAt: Date;
  updatedAt: Date;
  timestamp?: number; // Add missing timestamp
  ownerId?: string;
  nodeId: string; // Add missing nodeId
  tags?: Record<string, string>;
  state: ResourceState; // Add missing state
  health: ResourceHealth; // Add missing health
  capacity?: ResourceCapacity; // Add missing capacity
  performance?: any; // Add missing performance
  applicationData?: any; // Add missing applicationData

  lastModified?: Date;
  metadata?: Record<string, any>;
  distribution?: {
    shardCount?: number;
    preferredNodes?: string[];
  };}

export enum ResourceState {
  INITIALIZING = 'initializing',
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SCALING = 'scaling',
  MIGRATING = 'migrating',
  TERMINATING = 'terminating',
  ERROR = 'error',
  PENDING = 'pending'
}

export enum ResourceHealth {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy'
}

export interface ResourceCapacity {
  current: number;
  maximum: number;
  reserved: number;

  unit?: string;}

export interface ResourceTypeDefinition {
  name: string;
  typeName: string; // Add missing typeName
  version: string;
  schema: any;
  constraints?: any;
  onResourceCreated?: (resource: ResourceMetadata) => Promise<void>; // Add missing callback
  onResourceDestroyed?: (resource: ResourceMetadata) => Promise<void>; // Add missing callback

  onResourceMigrated?: (resource: ResourceMetadata, fromNode: string, toNode: string) => Promise<void>;}

export interface ResourceAttachment {
  id: string;
  resourceId: string;
  type: string;
  data: any;
  metadata: Record<string, any>;
}

export interface ResourceSubscription {
  id: string;
  resourceId: string;
  nodeId: string;
  filters?: any;
  callback: (event: any) => void;
}


export interface ResourceEvent { type: ResourceEventType; resourceId: string; data: any; timestamp: number;
  eventType: ResourceEventType;
  resourceType?: string;
  nodeId?: string;
  metadata?: Record<string, any>;}
export enum ResourceEventType { CREATED = "created", UPDATED = "updated", DELETED = "deleted",
  RESOURCE_CREATED = "resource_created",
  RESOURCE_UPDATED = "resource_updated",
  RESOURCE_DESTROYED = "resource_destroyed",
  RESOURCE_MIGRATED = "resource_migrated",}
