import { ResourceMetadata, ResourceState, ResourceHealth } from './types';
import { ResourceRegistry } from './ResourceRegistry';
import { ClusterManager } from '../ClusterManager';

export interface ResourceQuery {
  resourceTypes?: string[];
  states?: ResourceState[];
  healthStatus?: ResourceHealth[];
  nodeIds?: string[];
  tags?: Record<string, any>;
  capacity?: {
    min?: number;
    max?: number;
  };
  performance?: {
    maxLatency?: number;
    minThroughput?: number;
    maxErrorRate?: number;
  };
  metadata?: Record<string, any>;
  textSearch?: string;
  createdAfter?: number;
  updatedAfter?: number;
  limit?: number;
  offset?: number;
  sortBy?: 'timestamp' | 'resourceId' | 'state' | 'health';
  sortOrder?: 'asc' | 'desc';
}

export interface QueryResult {
  resources: ResourceMetadata[];
  totalCount: number;
  hasMore: boolean;
  queryTime: number;
}

export interface PerformanceCriteria {
  maxLatency?: number;
  minThroughput?: number;
  maxErrorRate?: number;
}

/**
 * Advanced resource querying and discovery engine
 * Provides sophisticated filtering, searching, and cluster-wide resource discovery
 */
export class ResourceQueryEngine {
  private resourceIndex = new Map<string, Set<string>>(); // tag -> resourceIds
  private performanceIndex = new Map<string, ResourceMetadata[]>(); // sorted by performance
  private queryCache = new Map<string, { result: QueryResult; timestamp: number }>();
  private cacheTimeout: number;
  
  constructor(
    private resourceRegistry: ResourceRegistry,
    private clusterManager: ClusterManager,
    private config: { cacheTimeout?: number } = {}
  ) {
    this.cacheTimeout = config.cacheTimeout || 30000; // 30 seconds
    this.buildIndexes();
    this.setupEventHandlers();
  }

  /**
   * Advanced resource querying with filtering, sorting, and pagination
   */
  async queryResources(query: ResourceQuery): Promise<QueryResult> {
    const startTime = Date.now();
    const cacheKey = this.generateCacheKey(query);
    
    // Check cache first
    const cached = this.queryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.result;
    }

    let resources = Array.from(this.resourceRegistry.getAllResources());
    
    // Apply filters
    resources = this.applyFilters(resources, query);
    
    // Apply sorting
    resources = this.applySorting(resources, query);
    
    // Apply pagination
    const totalCount = resources.length;
    const offset = query.offset || 0;
    const limit = query.limit || 100;
    resources = resources.slice(offset, offset + limit);
    
    const result: QueryResult = {
      resources,
      totalCount,
      hasMore: offset + limit < totalCount,
      queryTime: Date.now() - startTime
    };
    
    // Cache result
    this.queryCache.set(cacheKey, { result, timestamp: Date.now() });
    
    console.log(`🔍 Query executed: ${resources.length}/${totalCount} resources in ${result.queryTime}ms`);
    return result;
  }

  /**
   * Query across entire cluster for distributed resource discovery
   */
  async queryClusterWideResources(query: ResourceQuery): Promise<QueryResult> {
    const localResult = await this.queryResources(query);
    
    // Get results from other cluster members
    const members = this.clusterManager.membership.getAllMembers()
      .filter(m => m.status === 'ALIVE' && m.id !== this.clusterManager.localNodeId);
    
    if (members.length === 0) {
      return localResult;
    }
    
    console.log(`🌐 Querying ${members.length} cluster members for resources`);
    
    try {
      // Send query to cluster members
      const remoteQueries = members.map(member =>
        this.clusterManager.sendCustomMessage('resource:query', query, [member.id])
          .catch((error: any) => {
            console.warn(`Failed to query member ${member.id}:`, error);
            return null;
          })
      );
      
      const remoteResults = await Promise.allSettled(remoteQueries);
      
      // Merge results
      const allResources = [...localResult.resources];
      let totalCount = localResult.totalCount;
      
      for (const result of remoteResults) {
        if (result.status === 'fulfilled' && result.value) {
          const remoteResult = result.value as QueryResult;
          allResources.push(...remoteResult.resources);
          totalCount += remoteResult.totalCount;
        }
      }
      
      // Remove duplicates by resourceId
      const uniqueResources = Array.from(
        new Map(allResources.map(r => [r.resourceId, r])).values()
      );
      
      // Re-apply sorting and pagination to merged results
      const sortedResources = this.applySorting(uniqueResources, query);
      const offset = query.offset || 0;
      const limit = query.limit || 100;
      const paginatedResources = sortedResources.slice(offset, offset + limit);
      
      return {
        resources: paginatedResources,
        totalCount,
        hasMore: offset + limit < sortedResources.length,
        queryTime: Date.now() - localResult.queryTime
      };
    } catch (error) {
      console.error('Cluster-wide query failed, returning local results:', error);
      return localResult;
    }
  }

  /**
   * Search resources by text across multiple fields
   */
  searchResources(searchText: string, limit = 50): ResourceMetadata[] {
    const results: ResourceMetadata[] = [];
    const searchLower = searchText.toLowerCase();
    
    for (const resource of this.resourceRegistry.getAllResources()) {
      // Search in resourceId, type, and applicationData
      if (
        resource.resourceId.toLowerCase().includes(searchLower) ||
        resource.resourceType.toLowerCase().includes(searchLower) ||
        JSON.stringify(resource.applicationData).toLowerCase().includes(searchLower)
      ) {
        results.push(resource);
        if (results.length >= limit) break;
      }
    }
    
    console.log(`🔎 Text search for "${searchText}" found ${results.length} resources`);
    return results;
  }

  /**
   * Find resources meeting specific performance criteria
   */
  findHighPerformanceResources(criteria: PerformanceCriteria): ResourceMetadata[] {
    return Array.from(this.resourceRegistry.getAllResources()).filter(resource => {
      const perf = resource.performance;
      if (!perf) return false;
      
      if (criteria.maxLatency && perf.latency > criteria.maxLatency) return false;
      if (criteria.minThroughput && perf.throughput < criteria.minThroughput) return false;
      if (criteria.maxErrorRate && perf.errorRate > criteria.maxErrorRate) return false;
      
      return true;
    });
  }

  /**
   * Get resource recommendations based on capacity requirements
   */
  getResourceRecommendations(targetCapacity: number, resourceType?: string): ResourceMetadata[] {
    let candidates = Array.from(this.resourceRegistry.getAllResources());
    
    // Filter by resource type if specified
    if (resourceType) {
      candidates = candidates.filter(r => r.resourceType === resourceType);
    }
    
    // Filter by available capacity
    candidates = candidates.filter(r => {
      const available = r.capacity.maximum - r.capacity.current;
      return available >= targetCapacity;
    });
    
    // Sort by best fit (available capacity ascending, then by performance descending)
    candidates.sort((a, b) => {
      const aAvailable = a.capacity.maximum - a.capacity.current;
      const bAvailable = b.capacity.maximum - b.capacity.current;
      
      // First sort by available capacity (prefer resources with just enough capacity)
      const capacityDiff = aAvailable - bAvailable;
      if (capacityDiff !== 0) return capacityDiff;
      
      // Then by performance (higher throughput preferred)
      const aThroughput = a.performance?.throughput || 0;
      const bThroughput = b.performance?.throughput || 0;
      return bThroughput - aThroughput;
    });
    
    const recommendations = candidates.slice(0, 10); // Top 10 recommendations
    console.log(`💡 Found ${recommendations.length} resource recommendations for capacity ${targetCapacity}`);
    return recommendations;
  }

  /**
   * Get resources by health status
   */
  getResourcesByHealth(health: ResourceHealth): ResourceMetadata[] {
    return Array.from(this.resourceRegistry.getAllResources())
      .filter(r => r.health === health);
  }

  /**
   * Get resource utilization statistics
   */
  getUtilizationStats(): {
    totalResources: number;
    totalCapacity: number;
    usedCapacity: number;
    utilizationRate: number;
    healthyResources: number;
    unhealthyResources: number;
  } {
    const resources = Array.from(this.resourceRegistry.getAllResources());
    const totalResources = resources.length;
    const totalCapacity = resources.reduce((sum, r) => sum + r.capacity.maximum, 0);
    const usedCapacity = resources.reduce((sum, r) => sum + r.capacity.current, 0);
    const utilizationRate = totalCapacity > 0 ? usedCapacity / totalCapacity : 0;
    const healthyResources = resources.filter(r => r.health === ResourceHealth.HEALTHY).length;
    const unhealthyResources = resources.filter(r => r.health === ResourceHealth.UNHEALTHY).length;
    
    return {
      totalResources,
      totalCapacity,
      usedCapacity,
      utilizationRate,
      healthyResources,
      unhealthyResources
    };
  }

  private applyFilters(resources: ResourceMetadata[], query: ResourceQuery): ResourceMetadata[] {
    return resources.filter(resource => {
      // Resource type filter
      if (query.resourceTypes && !query.resourceTypes.includes(resource.resourceType)) {
        return false;
      }
      
      // State filter
      if (query.states && !query.states.includes(resource.state)) {
        return false;
      }
      
      // Health filter
      if (query.healthStatus && !query.healthStatus.includes(resource.health)) {
        return false;
      }
      
      // Node filter
      if (query.nodeIds && !query.nodeIds.includes(resource.nodeId)) {
        return false;
      }
      
      // Capacity filter
      if (query.capacity && resource.capacity) {
        const available = resource.capacity.maximum - resource.capacity.current;
        if (query.capacity.min && available < query.capacity.min) return false;
        if (query.capacity.max && available > query.capacity.max) return false;
      }
      
      // Performance filter
      if (query.performance && resource.performance) {
        if (query.performance.maxLatency && resource.performance.latency > query.performance.maxLatency) return false;
        if (query.performance.minThroughput && resource.performance.throughput < query.performance.minThroughput) return false;
        if (query.performance.maxErrorRate && resource.performance.errorRate > query.performance.maxErrorRate) return false;
      }
      
      // Text search
      if (query.textSearch) {
        const searchText = query.textSearch.toLowerCase();
        const resourceText = JSON.stringify(resource).toLowerCase();
        if (!resourceText.includes(searchText)) return false;
      }
      
      // Date filters
      if (query.createdAfter && resource.timestamp < query.createdAfter) return false;
      if (query.updatedAfter && resource.timestamp < query.updatedAfter) return false;
      
      return true;
    });
  }

  private applySorting(resources: ResourceMetadata[], query: ResourceQuery): ResourceMetadata[] {
    if (!query.sortBy) return resources;
    
    return resources.sort((a, b) => {
      let comparison = 0;
      
      switch (query.sortBy) {
        case 'timestamp':
          comparison = a.timestamp - b.timestamp;
          break;
        case 'resourceId':
          comparison = a.resourceId.localeCompare(b.resourceId);
          break;
        case 'state':
          comparison = a.state.localeCompare(b.state);
          break;
        case 'health':
          comparison = a.health.localeCompare(b.health);
          break;
      }
      
      return query.sortOrder === 'desc' ? -comparison : comparison;
    });
  }

  private generateCacheKey(query: ResourceQuery): string {
    return JSON.stringify(query);
  }

  private buildIndexes(): void {
    // Build performance index and other indexes
    this.performanceIndex.clear();
    // Implementation for building indexes can be added here
  }

  private setupEventHandlers(): void {
    // Clear cache when resources change
    this.resourceRegistry.on('resource:created', () => {
      this.queryCache.clear();
    });
    
    this.resourceRegistry.on('resource:updated', () => {
      this.queryCache.clear();
    });
    
    this.resourceRegistry.on('resource:destroyed', () => {
      this.queryCache.clear();
    });
  }
}
