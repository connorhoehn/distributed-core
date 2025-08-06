/**
 * Core types for the Application Module system
 */

import { ResourceMetadata, ResourceTypeDefinition } from '../cluster/resources/types';
import { ClusterManager } from '../cluster/ClusterManager';
import { ResourceRegistry } from '../cluster/resources/ResourceRegistry';
import { ResourceTopologyManager } from '../cluster/topology/ResourceTopologyManager';

// Forward declaration
export interface ApplicationModule {
  moduleId: string;
  moduleName: string;
  moduleState: ModuleState;
  managedResourceTypes: string[];
  initialize(context: ApplicationModuleContext): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  createResource(metadata: Partial<ResourceMetadata>): Promise<ResourceMetadata>;
  scaleResource(resourceId: string, strategy: ScalingStrategy): Promise<void>;
  deleteResource(resourceId: string): Promise<void>;
  getMetrics(): Promise<ApplicationModuleMetrics>;
  getDashboardData(): Promise<ApplicationModuleDashboardData>;
  healthCheck(): Promise<{ healthy: boolean; details?: any }>;
  getConfiguration(): ApplicationModuleConfig;
  updateConfiguration(newConfig: Partial<ApplicationModuleConfig>): Promise<void>;
}

/**
 * Application module lifecycle states
 */
export enum ModuleState {
  UNINITIALIZED = 'uninitialized',
  INITIALIZING = 'initializing',
  RUNNING = 'running',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
  ERROR = 'error'
}

/**
 * Application module configuration
 */
export interface ApplicationModuleConfig {
  moduleId: string;
  moduleName: string;
  version: string;
  description?: string;
  dependencies?: string[]; // Other module IDs this module depends on
  resourceTypes: string[]; // Resource types this module manages
  configuration: Record<string, any>; // Module-specific configuration
}

/**
 * Application module metrics
 */
export interface ApplicationModuleMetrics {
  moduleId: string;
  timestamp: number;
  state: ModuleState;
  resourceCounts: Record<string, number>; // resourceType -> count
  performance: {
    requestsPerSecond: number;
    averageLatency: number;
    errorRate: number;
    uptime: number;
  };
  custom?: Record<string, any>; // Module-specific metrics
}

/**
 * Application module dashboard data
 */
export interface ApplicationModuleDashboardData {
  moduleId: string;
  moduleName: string;
  state: ModuleState;
  summary: {
    totalResources: number;
    healthyResources: number;
    activeConnections: number;
    throughput: number;
  };
  charts: {
    title: string;
    type: 'line' | 'bar' | 'pie' | 'gauge';
    data: any;
  }[];
  alerts?: {
    level: 'info' | 'warning' | 'error' | 'critical';
    message: string;
    timestamp: number;
  }[];
}

/**
 * Resource scaling strategy
 */
export interface ScalingStrategy {
  type: 'manual' | 'auto' | 'predictive';
  triggers: {
    cpuThreshold?: number;
    memoryThreshold?: number;
    connectionThreshold?: number;
    latencyThreshold?: number;
    customMetrics?: Record<string, number>;
  };
  actions: {
    scaleUp: {
      enabled: boolean;
      maxInstances: number;
      cooldownPeriod: number; // ms
    };
    scaleDown: {
      enabled: boolean;
      minInstances: number;
      cooldownPeriod: number; // ms
    };
  };
}

/**
 * Application module context - provided to modules during initialization
 */
export interface ApplicationModuleContext {
  clusterManager: ClusterManager;
  resourceRegistry: ResourceRegistry;
  topologyManager: ResourceTopologyManager;
  moduleRegistry: ApplicationRegistry; // Forward declaration
  configuration: Record<string, any>;
  logger: {
    info: (message: string, meta?: any) => void;
    warn: (message: string, meta?: any) => void;
    error: (message: string, meta?: any) => void;
    debug: (message: string, meta?: any) => void;
  };
}

/**
 * Forward declaration for ApplicationRegistry
 */
export interface ApplicationRegistry {
  registerModule(module: ApplicationModule): Promise<void>;
  unregisterModule(moduleId: string): Promise<void>;
  getModule(moduleId: string): ApplicationModule | undefined;
  getAllModules(): ApplicationModule[];
  getModulesByResourceType(resourceType: string): ApplicationModule[];
}
