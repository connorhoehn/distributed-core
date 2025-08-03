/**
 * StateDelta - Incremental state updates for efficient synchronization
 */

import { LogicalService, VectorClock } from '../introspection/ClusterIntrospection';
import { StateFingerprint, FingerprintComparison } from './StateFingerprint';

/**
 * Types of delta operations
 */
export type DeltaOperation = 'add' | 'modify' | 'delete';

/**
 * Individual service change
 */
export interface ServiceDelta {
  operation: DeltaOperation;
  serviceId: string;
  service?: LogicalService;          // Full service for add/modify
  patch?: ServicePatch;              // Partial changes for modify
  previousVersion?: number;          // For conflict detection
  timestamp: number;
}

/**
 * Partial service updates
 */
export interface ServicePatch {
  stats?: Partial<Record<string, any>>;
  metadata?: Partial<Record<string, any>>;
  version?: number;
  vectorClock?: VectorClock;
  lastUpdated?: number;
}

/**
 * Complete state delta
 */
export interface StateDelta {
  id: string;                        // Unique delta identifier
  sourceNodeId: string;             // Node that generated this delta
  targetNodeId?: string;            // Specific target (optional)
  sourceFingerprint: string;        // State this delta applies to
  targetFingerprint?: string;       // Expected state after applying delta
  
  // Delta operations
  services: ServiceDelta[];
  
  // Metadata
  timestamp: number;
  version: number;
  sequenceNumber: number;           // For ordering
  
  // Conflict resolution
  vectorClockUpdates: VectorClock;
  causality: string[];              // Dependencies on other deltas
  
  // Compression/encryption metadata
  compressed: boolean;
  encrypted: boolean;
  originalSize?: number;
  compressedSize?: number;
}

/**
 * Delta application result
 */
export interface DeltaApplicationResult {
  success: boolean;
  appliedOperations: number;
  failedOperations: ServiceDelta[];
  conflicts: ServiceConflict[];
  resultingServices: LogicalService[];
  newFingerprint: string;
}

/**
 * Conflict during delta application
 */
export interface ServiceConflict {
  serviceId: string;
  conflictType: 'version' | 'causality' | 'missing-dependency' | 'already-deleted';
  expectedVersion?: number;
  actualVersion?: number;
  description: string;
}

/**
 * Configuration for delta generation
 */
export interface DeltaConfig {
  maxDeltaSize: number;              // Max operations per delta
  includeFullServices: boolean;      // Include full service vs patches
  enableCausality: boolean;         // Track delta dependencies
  compressionThreshold: number;     // Compress deltas > X bytes
  enableEncryption: boolean;        // Encrypt sensitive deltas
}

/**
 * StateDelta handles generation and application of incremental state changes
 */
export class StateDeltaManager {
  private config: DeltaConfig;
  private sequenceCounter = 0;

  constructor(config: Partial<DeltaConfig> = {}) {
    this.config = {
      maxDeltaSize: 100,
      includeFullServices: true,
      enableCausality: true,
      compressionThreshold: 1024, // 1KB
      enableEncryption: false,
      ...config
    };
  }

  /**
   * Generate delta from fingerprint comparison
   */
  generateDelta(
    localServices: LogicalService[],
    comparison: FingerprintComparison,
    sourceNodeId: string,
    sourceFingerprint: string,
    targetNodeId?: string
  ): StateDelta[] {
    const deltas: StateDelta[] = [];
    const allOperations: ServiceDelta[] = [];

    // Create service lookup
    const serviceMap = new Map(localServices.map(s => [s.id, s]));

    // Generate add operations
    for (const serviceId of comparison.addedServices) {
      const service = serviceMap.get(serviceId);
      if (service) {
        allOperations.push({
          operation: 'add',
          serviceId,
          service: this.config.includeFullServices ? service : undefined,
          patch: this.config.includeFullServices ? undefined : this.createFullPatch(service),
          timestamp: Date.now()
        });
      }
    }

    // Generate modify operations
    for (const serviceId of comparison.modifiedServices) {
      const service = serviceMap.get(serviceId);
      if (service) {
        allOperations.push({
          operation: 'modify',
          serviceId,
          service: this.config.includeFullServices ? service : undefined,
          patch: this.config.includeFullServices ? undefined : this.createModifyPatch(service),
          previousVersion: service.version ? service.version - 1 : 0,
          timestamp: Date.now()
        });
      }
    }

    // Generate delete operations
    for (const serviceId of comparison.removedServices) {
      allOperations.push({
        operation: 'delete',
        serviceId,
        timestamp: Date.now()
      });
    }

    // Split into multiple deltas if needed
    for (let i = 0; i < allOperations.length; i += this.config.maxDeltaSize) {
      const chunk = allOperations.slice(i, i + this.config.maxDeltaSize);
      
      const delta: StateDelta = {
        id: `delta-${Date.now()}-${++this.sequenceCounter}`,
        sourceNodeId,
        targetNodeId,
        sourceFingerprint,
        services: chunk,
        timestamp: Date.now(),
        version: 1,
        sequenceNumber: this.sequenceCounter,
        vectorClockUpdates: this.generateVectorClockUpdates(chunk),
        causality: [], // TODO: Implement causality tracking
        compressed: false,
        encrypted: false
      };

      deltas.push(delta);
    }

    return deltas;
  }

  /**
   * Apply delta to current service state
   */
  applyDelta(
    currentServices: LogicalService[],
    delta: StateDelta
  ): DeltaApplicationResult {
    const result: DeltaApplicationResult = {
      success: true,
      appliedOperations: 0,
      failedOperations: [],
      conflicts: [],
      resultingServices: [...currentServices],
      newFingerprint: ''
    };

    const serviceMap = new Map(result.resultingServices.map(s => [s.id, s]));

    // Apply each operation
    for (const operation of delta.services) {
      try {
        const operationResult = this.applyServiceOperation(serviceMap, operation);
        
        if (operationResult.success) {
          result.appliedOperations++;
        } else {
          result.failedOperations.push(operation);
          result.conflicts.push(...operationResult.conflicts);
        }
      } catch (error) {
        result.failedOperations.push(operation);
        result.conflicts.push({
          serviceId: operation.serviceId,
          conflictType: 'version',
          description: `Failed to apply operation: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }

    // Update resulting services
    result.resultingServices = Array.from(serviceMap.values());
    result.success = result.failedOperations.length === 0;

    return result;
  }

  /**
   * Create delta for specific service changes
   */
  createServiceDelta(
    before: LogicalService,
    after: LogicalService,
    sourceNodeId: string
  ): ServiceDelta {
    if (before.id !== after.id) {
      throw new Error('Service IDs must match for delta creation');
    }

    const patch = this.generatePatch(before, after);
    
    return {
      operation: 'modify',
      serviceId: after.id,
      service: this.config.includeFullServices ? after : undefined,
      patch: this.config.includeFullServices ? undefined : patch,
      previousVersion: before.version,
      timestamp: Date.now()
    };
  }

  /**
   * Merge multiple deltas into a single delta
   */
  mergeDeltas(deltas: StateDelta[]): StateDelta {
    if (deltas.length === 0) {
      throw new Error('Cannot merge empty delta array');
    }

    if (deltas.length === 1) {
      return deltas[0];
    }

    const mergedServices: ServiceDelta[] = [];
    const serviceOperations = new Map<string, ServiceDelta>();

    // Process deltas in order
    for (const delta of deltas.sort((a, b) => a.sequenceNumber - b.sequenceNumber)) {
      for (const operation of delta.services) {
        serviceOperations.set(operation.serviceId, operation);
      }
    }

    mergedServices.push(...serviceOperations.values());

    return {
      id: `merged-delta-${Date.now()}`,
      sourceNodeId: deltas[0].sourceNodeId,
      sourceFingerprint: deltas[0].sourceFingerprint,
      services: mergedServices,
      timestamp: Date.now(),
      version: Math.max(...deltas.map(d => d.version)),
      sequenceNumber: Math.max(...deltas.map(d => d.sequenceNumber)),
      vectorClockUpdates: this.mergeVectorClocks(deltas.map(d => d.vectorClockUpdates)),
      causality: Array.from(new Set(deltas.flatMap(d => d.causality))),
      compressed: false,
      encrypted: false
    };
  }

  /**
   * Calculate delta size in bytes
   */
  calculateDeltaSize(delta: StateDelta): number {
    const serialized = JSON.stringify(delta);
    return Buffer.byteLength(serialized, 'utf8');
  }

  /**
   * Validate delta integrity
   */
  validateDelta(delta: StateDelta): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!delta.id || !delta.sourceNodeId) {
      errors.push('Missing required delta identifiers');
    }

    if (!delta.sourceFingerprint) {
      errors.push('Missing source fingerprint');
    }

    if (delta.services.length === 0) {
      errors.push('Delta contains no operations');
    }

    // Validate service operations
    for (const operation of delta.services) {
      if (!operation.serviceId) {
        errors.push(`Service operation missing serviceId`);
      }

      if (operation.operation === 'add' || operation.operation === 'modify') {
        if (!operation.service && !operation.patch) {
          errors.push(`${operation.operation} operation missing service data`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Apply single service operation
   */
  private applyServiceOperation(
    serviceMap: Map<string, LogicalService>,
    operation: ServiceDelta
  ): { success: boolean; conflicts: ServiceConflict[] } {
    const conflicts: ServiceConflict[] = [];

    switch (operation.operation) {
      case 'add':
        if (serviceMap.has(operation.serviceId)) {
          conflicts.push({
            serviceId: operation.serviceId,
            conflictType: 'version',
            description: 'Service already exists'
          });
          return { success: false, conflicts };
        }

        if (operation.service) {
          serviceMap.set(operation.serviceId, operation.service);
        } else if (operation.patch) {
          // Create new service from patch
          const newService = this.createServiceFromPatch(operation.serviceId, operation.patch);
          serviceMap.set(operation.serviceId, newService);
        }
        break;

      case 'modify':
        const existingService = serviceMap.get(operation.serviceId);
        
        if (!existingService) {
          conflicts.push({
            serviceId: operation.serviceId,
            conflictType: 'missing-dependency',
            description: 'Service does not exist for modification'
          });
          return { success: false, conflicts };
        }

        // Check version compatibility
        if (operation.previousVersion !== undefined && 
            existingService.version !== undefined &&
            existingService.version !== operation.previousVersion) {
          conflicts.push({
            serviceId: operation.serviceId,
            conflictType: 'version',
            expectedVersion: operation.previousVersion,
            actualVersion: existingService.version,
            description: 'Version conflict during modification'
          });
          return { success: false, conflicts };
        }

        if (operation.service) {
          serviceMap.set(operation.serviceId, operation.service);
        } else if (operation.patch) {
          const updatedService = this.applyPatch(existingService, operation.patch);
          serviceMap.set(operation.serviceId, updatedService);
        }
        break;

      case 'delete':
        if (!serviceMap.has(operation.serviceId)) {
          // Service already deleted or never existed - this is not an error in distributed systems
          // Just log as a warning and continue
          conflicts.push({
            serviceId: operation.serviceId,
            conflictType: 'already-deleted',
            description: 'Service does not exist for deletion (already deleted or never existed)'
          });
          // Continue processing rather than failing
          break;
        }

        serviceMap.delete(operation.serviceId);
        break;
    }

    return { success: true, conflicts: [] };
  }

  /**
   * Generate patch between two services
   */
  private generatePatch(before: LogicalService, after: LogicalService): ServicePatch {
    const patch: ServicePatch = {};

    // Compare stats
    if (JSON.stringify(before.stats) !== JSON.stringify(after.stats)) {
      patch.stats = after.stats;
    }

    // Compare metadata
    if (JSON.stringify(before.metadata) !== JSON.stringify(after.metadata)) {
      patch.metadata = after.metadata;
    }

    // Always include version and vector clock updates
    if (after.version !== before.version) {
      patch.version = after.version;
    }

    if (JSON.stringify(after.vectorClock) !== JSON.stringify(before.vectorClock)) {
      patch.vectorClock = after.vectorClock;
    }

    if (after.lastUpdated !== before.lastUpdated) {
      patch.lastUpdated = after.lastUpdated;
    }

    return patch;
  }

  /**
   * Apply patch to service
   */
  private applyPatch(service: LogicalService, patch: ServicePatch): LogicalService {
    const updated = { ...service };

    if (patch.stats) {
      updated.stats = { ...updated.stats, ...patch.stats };
    }

    if (patch.metadata) {
      updated.metadata = { ...updated.metadata, ...patch.metadata };
    }

    if (patch.version !== undefined) {
      updated.version = patch.version;
    }

    if (patch.vectorClock) {
      updated.vectorClock = { ...updated.vectorClock, ...patch.vectorClock };
    }

    if (patch.lastUpdated !== undefined) {
      updated.lastUpdated = patch.lastUpdated;
    }

    return updated;
  }

  /**
   * Create full patch from service
   */
  private createFullPatch(service: LogicalService): ServicePatch {
    return {
      stats: service.stats,
      metadata: service.metadata,
      version: service.version,
      vectorClock: service.vectorClock,
      lastUpdated: service.lastUpdated
    };
  }

  /**
   * Create modify patch (simplified - would include diff logic)
   */
  private createModifyPatch(service: LogicalService): ServicePatch {
    return this.createFullPatch(service);
  }

  /**
   * Create service from patch
   */
  private createServiceFromPatch(serviceId: string, patch: ServicePatch): LogicalService {
    return {
      id: serviceId,
      type: 'unknown', // Would need type in patch
      nodeId: 'unknown', // Would need nodeId in patch
      metadata: patch.metadata || {},
      stats: patch.stats || {},
      lastUpdated: patch.lastUpdated || Date.now(),
      version: patch.version || 1,
      vectorClock: patch.vectorClock || {},
      checksum: 'pending',
      conflictPolicy: 'last-writer-wins'
    };
  }

  /**
   * Generate vector clock updates from operations
   */
  private generateVectorClockUpdates(operations: ServiceDelta[]): VectorClock {
    const updates: VectorClock = {};
    
    for (const operation of operations) {
      if (operation.service?.vectorClock) {
        Object.assign(updates, operation.service.vectorClock);
      }
    }

    return updates;
  }

  /**
   * Merge multiple vector clocks
   */
  private mergeVectorClocks(clocks: VectorClock[]): VectorClock {
    const merged: VectorClock = {};
    
    for (const clock of clocks) {
      for (const [nodeId, version] of Object.entries(clock)) {
        merged[nodeId] = Math.max(merged[nodeId] || 0, version);
      }
    }

    return merged;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<DeltaConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): DeltaConfig {
    return { ...this.config };
  }
}
