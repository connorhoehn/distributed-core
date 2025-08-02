/**
 * State reconciliation engine for resolving conflicts between nodes
 */

import { EventEmitter } from 'events';
import { StateConflict, LogicalService, VectorClock } from '../introspection/ClusterIntrospection';

/**
 * Resolution strategy type
 */
export type ResolutionStrategy = 
  | 'max-value'           // Take the maximum numeric value
  | 'min-value'           // Take the minimum numeric value
  | 'last-writer-wins'    // Use the most recent version (by vector clock)
  | 'first-writer-wins'   // Use the earliest version (by vector clock)
  | 'union-merge'         // Merge arrays/objects by combining values
  | 'manual'              // Require human intervention
  | 'average'             // Take the average of numeric values
  | 'majority'            // Take the value that appears most frequently
  | 'custom';             // Use a custom resolution function

/**
 * Configuration for conflict resolution
 */
export interface ResolutionConfig {
  // Default strategy for different conflict types
  defaultStrategies: {
    version: ResolutionStrategy;
    stats: ResolutionStrategy;
    metadata: ResolutionStrategy;
    missing: ResolutionStrategy;
  };
  
  // Field-specific strategy overrides
  fieldStrategies: Map<string, ResolutionStrategy>;
  
  // Custom resolution functions
  customResolvers: Map<string, (values: Map<string, any>, metadata?: any) => any>;
  
  // Resolution behavior
  enableAutoResolution: boolean;
  requireConfirmation: boolean;
  maxRetries: number;
  resolutionTimeout: number;
}

/**
 * Result of a conflict resolution
 */
export interface ResolutionResult {
  conflictId: string;
  strategy: ResolutionStrategy;
  resolvedValue: any;
  sourceNodes: string[];
  confidence: number; // 0-1 score indicating confidence in resolution
  timestamp: number;
  metadata?: any;
}

/**
 * Preview of what resolution would do without applying changes
 */
export interface ResolutionPreview {
  conflict: StateConflict;
  strategy: ResolutionStrategy;
  currentValue: any;
  proposedValue: any;
  confidence: number;
  reasoning: string;
}

/**
 * StateReconciler handles conflict resolution using pluggable strategies
 */
export class StateReconciler extends EventEmitter {
  private config: ResolutionConfig;
  private pendingResolutions = new Map<string, ResolutionResult>();
  private resolutionHistory: ResolutionResult[] = [];

  constructor(config: Partial<ResolutionConfig> = {}) {
    super();
    
    this.config = {
      defaultStrategies: {
        version: 'max-value',
        stats: 'max-value',
        metadata: 'last-writer-wins',
        missing: 'union-merge'
      },
      fieldStrategies: new Map(),
      customResolvers: new Map(),
      enableAutoResolution: false,
      requireConfirmation: true,
      maxRetries: 3,
      resolutionTimeout: 30000,
      ...config
    };

    this.setupDefaultResolvers();
  }

  /**
   * Resolve a single conflict using configured strategies
   */
  async resolveConflict(
    conflict: StateConflict, 
    strategy?: ResolutionStrategy,
    dryRun: boolean = false
  ): Promise<ResolutionResult> {
    const effectiveStrategy = strategy || this.getStrategyForConflict(conflict);
    
    if (effectiveStrategy === 'manual') {
      throw new Error(`Manual resolution required for conflict: ${conflict.serviceId}`);
    }

    const resolver = this.getResolver(effectiveStrategy);
    if (!resolver) {
      throw new Error(`No resolver found for strategy: ${effectiveStrategy}`);
    }

    const resolvedValue = resolver(conflict.values, { conflict, strategy: effectiveStrategy });
    const confidence = this.calculateConfidence(conflict, effectiveStrategy, resolvedValue);

    const result: ResolutionResult = {
      conflictId: `${conflict.serviceId}-${conflict.conflictType}`,
      strategy: effectiveStrategy,
      resolvedValue,
      sourceNodes: conflict.nodes,
      confidence,
      timestamp: Date.now(),
      metadata: { 
        originalValues: Object.fromEntries(conflict.values),
        conflictType: conflict.conflictType,
        severity: conflict.severity
      }
    };

    if (!dryRun) {
      this.pendingResolutions.set(result.conflictId, result);
      this.resolutionHistory.push(result);
      this.emit('conflict-resolved', result);
    }

    return result;
  }

  /**
   * Resolve multiple conflicts in batch
   */
  async resolveConflicts(
    conflicts: StateConflict[], 
    dryRun: boolean = false
  ): Promise<ResolutionResult[]> {
    const results: ResolutionResult[] = [];
    
    for (const conflict of conflicts) {
      try {
        const result = await this.resolveConflict(conflict, undefined, dryRun);
        results.push(result);
      } catch (error) {
        this.emit('resolution-failed', { conflict, error });
      }
    }

    if (!dryRun && results.length > 0) {
      this.emit('conflicts-batch-resolved', results);
    }

    return results;
  }

  /**
   * Preview what resolution would do without applying changes
   */
  previewResolution(conflicts: StateConflict[]): ResolutionPreview[] {
    return conflicts.map(conflict => {
      const strategy = this.getStrategyForConflict(conflict);
      const resolver = this.getResolver(strategy);
      
      let proposedValue: any;
      let reasoning: string;
      let confidence: number;

      if (!resolver || strategy === 'manual') {
        proposedValue = null;
        reasoning = strategy === 'manual' ? 'Manual resolution required' : `No resolver for ${strategy}`;
        confidence = 0;
      } else {
        try {
          proposedValue = resolver(conflict.values, { conflict, strategy });
          reasoning = this.getResolutionReasoning(conflict, strategy, proposedValue);
          confidence = this.calculateConfidence(conflict, strategy, proposedValue);
        } catch (error) {
          proposedValue = null;
          reasoning = `Resolution failed: ${error instanceof Error ? error.message : String(error)}`;
          confidence = 0;
        }
      }

      return {
        conflict,
        strategy,
        currentValue: Array.from(conflict.values.values())[0], // First value as reference
        proposedValue,
        confidence,
        reasoning
      };
    });
  }

  /**
   * Apply resolved values to logical services
   */
  applyResolutions(
    services: LogicalService[], 
    resolutions: ResolutionResult[]
  ): LogicalService[] {
    const resolvedServices = [...services];
    const resolutionMap = new Map(resolutions.map(r => [r.conflictId, r]));

    for (const service of resolvedServices) {
      // Apply version resolutions
      const versionResolution = resolutionMap.get(`${service.id}-version`);
      if (versionResolution) {
        service.version = versionResolution.resolvedValue;
      }

      // Apply stats resolutions
      for (const [key, value] of Object.entries(service.stats)) {
        const statsResolution = resolutionMap.get(`${service.id}.${key}-stats`);
        if (statsResolution) {
          service.stats[key] = statsResolution.resolvedValue;
        }
      }

      // Apply metadata resolutions
      for (const [key, value] of Object.entries(service.metadata)) {
        const metaResolution = resolutionMap.get(`${service.id}.${key}-metadata`);
        if (metaResolution) {
          service.metadata[key] = metaResolution.resolvedValue;
        }
      }

      // Update vector clock and checksum after resolution
      if (service.vectorClock) {
        service.vectorClock[service.nodeId] = (service.vectorClock[service.nodeId] || 0) + 1;
      }
      
      service.lastUpdated = Date.now();
    }

    return resolvedServices;
  }

  /**
   * Get pending resolutions that haven't been applied yet
   */
  getPendingResolutions(): ResolutionResult[] {
    return Array.from(this.pendingResolutions.values());
  }

  /**
   * Clear pending resolutions after they've been applied
   */
  clearPendingResolutions(): void {
    this.pendingResolutions.clear();
  }

  /**
   * Get resolution history for audit purposes
   */
  getResolutionHistory(limit?: number): ResolutionResult[] {
    return limit ? this.resolutionHistory.slice(-limit) : [...this.resolutionHistory];
  }

  /**
   * Configure field-specific resolution strategies
   */
  configureFieldStrategy(fieldPattern: string, strategy: ResolutionStrategy): void {
    this.config.fieldStrategies.set(fieldPattern, strategy);
  }

  /**
   * Add a custom resolution function
   */
  addCustomResolver(
    name: string, 
    resolver: (values: Map<string, any>, metadata?: any) => any
  ): void {
    this.config.customResolvers.set(name, resolver);
  }

  /**
   * Update resolution configuration
   */
  updateConfig(config: Partial<ResolutionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get the appropriate strategy for a conflict
   */
  private getStrategyForConflict(conflict: StateConflict): ResolutionStrategy {
    // Check for field-specific strategies first
    const serviceField = conflict.serviceId.includes('.') 
      ? conflict.serviceId.split('.').slice(1).join('.')
      : '';
    
    if (serviceField) {
      for (const [pattern, strategy] of this.config.fieldStrategies) {
        if (this.matchesPattern(serviceField, pattern)) {
          return strategy;
        }
      }
    }

    // Fall back to default strategy for conflict type
    return this.config.defaultStrategies[conflict.conflictType] || 'manual';
  }

  /**
   * Get resolver function for a strategy
   */
  private getResolver(strategy: ResolutionStrategy): ((values: Map<string, any>, metadata?: any) => any) | null {
    if (this.config.customResolvers.has(strategy)) {
      return this.config.customResolvers.get(strategy)!;
    }

    switch (strategy) {
      case 'max-value':
        return (values) => Math.max(...Array.from(values.values()).filter(v => typeof v === 'number'));
      
      case 'min-value':
        return (values) => Math.min(...Array.from(values.values()).filter(v => typeof v === 'number'));
      
      case 'average':
        return (values) => {
          const nums = Array.from(values.values()).filter(v => typeof v === 'number');
          return nums.reduce((sum, val) => sum + val, 0) / nums.length;
        };
      
      case 'majority':
        return (values) => {
          const counts = new Map();
          for (const value of values.values()) {
            const key = JSON.stringify(value);
            counts.set(key, (counts.get(key) || 0) + 1);
          }
          const maxCount = Math.max(...counts.values());
          const majorityKey = Array.from(counts.entries()).find(([k, v]) => v === maxCount)?.[0];
          return majorityKey ? JSON.parse(majorityKey) : Array.from(values.values())[0];
        };
      
      case 'last-writer-wins':
      case 'first-writer-wins':
        return (values) => Array.from(values.values())[0]; // Simplified - would need vector clock comparison
      
      case 'union-merge':
        return (values) => {
          const allValues = Array.from(values.values());
          if (allValues.every(v => Array.isArray(v))) {
            return [...new Set(allValues.flat())];
          }
          if (allValues.every(v => typeof v === 'object' && v !== null)) {
            return Object.assign({}, ...allValues);
          }
          return allValues[0];
        };
      
      default:
        return null;
    }
  }

  /**
   * Calculate confidence score for a resolution
   */
  private calculateConfidence(
    conflict: StateConflict, 
    strategy: ResolutionStrategy, 
    resolvedValue: any
  ): number {
    const valueCount = conflict.values.size;
    
    if (valueCount <= 1) {
      return 1.0; // Perfect confidence with single value
    }
    
    const uniqueValues = new Set(Array.from(conflict.values.values()).map(v => JSON.stringify(v))).size;
    
    // Higher confidence when values are more similar
    const similarity = valueCount > 1 ? 1 - (uniqueValues - 1) / (valueCount - 1) : 1.0;
    
    // Strategy-specific confidence adjustments
    let strategyConfidence = 0.8; // Default
    
    switch (strategy) {
      case 'max-value':
      case 'min-value':
        strategyConfidence = 0.9; // High confidence for numeric strategies
        break;
      case 'majority':
        // For majority, check how clear the majority is
        const valueCounts = new Map<string, number>();
        for (const value of conflict.values.values()) {
          const key = JSON.stringify(value);
          valueCounts.set(key, (valueCounts.get(key) || 0) + 1);
        }
        const maxCount = Math.max(...valueCounts.values());
        const majorityRatio = maxCount / valueCount;
        strategyConfidence = majorityRatio > 0.6 ? 0.9 : 0.6;
        break;
      case 'average':
        strategyConfidence = 0.7; // Medium confidence for averages
        break;
      case 'union-merge':
        strategyConfidence = 0.8; // Good for combining data
        break;
      case 'last-writer-wins':
        strategyConfidence = 0.6; // Lower confidence without proper causality
        break;
    }
    
    return Math.min(Math.max(similarity * strategyConfidence, 0.1), 1.0); // Ensure minimum 0.1 confidence
  }

  /**
   * Generate human-readable reasoning for resolution
   */
  private getResolutionReasoning(
    conflict: StateConflict, 
    strategy: ResolutionStrategy, 
    resolvedValue: any
  ): string {
    const nodeCount = conflict.nodes.length;
    const values = Array.from(conflict.values.values());
    
    switch (strategy) {
      case 'max-value':
        return `Selected maximum value (${resolvedValue}) from ${nodeCount} nodes`;
      case 'min-value':
        return `Selected minimum value (${resolvedValue}) from ${nodeCount} nodes`;
      case 'average':
        return `Calculated average (${resolvedValue}) from ${nodeCount} conflicting values`;
      case 'majority':
        return `Selected majority value (${resolvedValue}) appearing most frequently`;
      case 'last-writer-wins':
        return `Selected most recent value (${resolvedValue}) based on vector clock`;
      case 'union-merge':
        return `Merged all values from ${nodeCount} nodes into combined result`;
      default:
        return `Applied ${strategy} strategy to resolve conflict across ${nodeCount} nodes`;
    }
  }

  /**
   * Check if a field matches a pattern (supports wildcards)
   */
  private matchesPattern(field: string, pattern: string): boolean {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(field);
    }
    return field === pattern;
  }

  /**
   * Setup default custom resolvers
   */
  private setupDefaultResolvers(): void {
    // Add any default custom resolvers here
    this.addCustomResolver('timestamp-max', (values) => {
      return Math.max(...Array.from(values.values()).filter(v => typeof v === 'number'));
    });
    
    this.addCustomResolver('string-longest', (values) => {
      const strings = Array.from(values.values()).filter(v => typeof v === 'string');
      return strings.reduce((longest, current) => 
        current.length > longest.length ? current : longest, '');
    });
  }
}
