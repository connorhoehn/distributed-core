import { Logger } from '../common/logger';

/**
 * Operation trace for debugging distributed operations
 */
export interface OperationTrace {
  opId: string;
  resourceId: string;
  phase: 'wal' | 'local' | 'route' | 'send' | 'recv' | 'apply' | 'deliver';
  nodeId: string;
  timestamp: number;
  duration?: number;
  error?: string;
  metadata?: Record<string, any>;
}

/**
 * Distribution metrics for observability
 */
export interface DistributionMetrics {
  operations: {
    total: number;
    byPhase: Record<string, number>;
    byNode: Record<string, number>;
    errors: number;
    averageLatencyMs: number;
  };
  queues: {
    depth: Record<string, number>; // connectionId -> depth
    drops: Record<string, number>; // connectionId -> drops
    slowConsumers: string[];
  };
  routing: {
    localHits: number;
    remoteHits: number;
    gossipFallbacks: number;
  };
  wal: {
    entries: number;
    messageRecords: number;
    membershipRecords: number;
    replayTimeMs: number;
  };
}

/**
 * Observability manager for distributed communication
 */
export class ObservabilityManager {
  private logger = Logger.create('ObservabilityManager');
  private traces: OperationTrace[] = [];
  private metrics: DistributionMetrics = {
    operations: {
      total: 0,
      byPhase: {},
      byNode: {},
      errors: 0,
      averageLatencyMs: 0
    },
    queues: {
      depth: {},
      drops: {},
      slowConsumers: []
    },
    routing: {
      localHits: 0,
      remoteHits: 0,
      gossipFallbacks: 0
    },
    wal: {
      entries: 0,
      messageRecords: 0,
      membershipRecords: 0,
      replayTimeMs: 0
    }
  };
  private maxTraces: number;

  constructor(maxTraces: number = 1000) {
    this.maxTraces = maxTraces;
  }

  /**
   * Trace an operation phase for debugging
   */
  trace(trace: Omit<OperationTrace, 'timestamp'>): void {
    const fullTrace: OperationTrace = {
      ...trace,
      timestamp: Date.now()
    };

    this.traces.push(fullTrace);
    
    // Keep traces bounded
    if (this.traces.length > this.maxTraces) {
      this.traces.shift();
    }

    // Update metrics
    this.metrics.operations.total++;
    this.metrics.operations.byPhase[trace.phase] = (this.metrics.operations.byPhase[trace.phase] || 0) + 1;
    this.metrics.operations.byNode[trace.nodeId] = (this.metrics.operations.byNode[trace.nodeId] || 0) + 1;
    
    if (trace.error) {
      this.metrics.operations.errors++;
    }

    // Log important phases
    if (trace.phase === 'send' || trace.phase === 'recv' || trace.error) {
      const status = trace.error ? '❌' : '✅';
      this.logger.info(`${status} [${trace.phase.toUpperCase()}] ${trace.opId} on ${trace.nodeId} ${trace.duration ? `(${trace.duration}ms)` : ''}${trace.error ? `: ${trace.error}` : ''}`);
    }
  }

  /**
   * Record queue metrics
   */
  recordQueue(connectionId: string, depth: number, dropped: boolean = false): void {
    this.metrics.queues.depth[connectionId] = depth;
    
    if (dropped) {
      this.metrics.queues.drops[connectionId] = (this.metrics.queues.drops[connectionId] || 0) + 1;
    }

    // Detect slow consumers (queue depth > 50% of max)
    const maxDepth = 2048; // Should get from config
    if (depth > maxDepth * 0.5) {
      if (!this.metrics.queues.slowConsumers.includes(connectionId)) {
        this.metrics.queues.slowConsumers.push(connectionId);
        this.logger.warn(`Slow consumer detected: ${connectionId} (queue depth: ${depth})`);
      }
    } else {
      // Remove from slow consumers if recovered
      const index = this.metrics.queues.slowConsumers.indexOf(connectionId);
      if (index > -1) {
        this.metrics.queues.slowConsumers.splice(index, 1);
        this.logger.info(`Consumer recovered: ${connectionId} (queue depth: ${depth})`);
      }
    }
  }

  /**
   * Record routing metrics
   */
  recordRouting(type: 'local' | 'remote' | 'gossip'): void {
    switch (type) {
      case 'local':
        this.metrics.routing.localHits++;
        break;
      case 'remote':
        this.metrics.routing.remoteHits++;
        break;
      case 'gossip':
        this.metrics.routing.gossipFallbacks++;
        break;
    }
  }

  /**
   * Record WAL metrics
   */
  recordWAL(type: 'message' | 'membership', replayTimeMs?: number): void {
    this.metrics.wal.entries++;
    
    if (type === 'message') {
      this.metrics.wal.messageRecords++;
    } else {
      this.metrics.wal.membershipRecords++;
    }

    if (replayTimeMs !== undefined) {
      this.metrics.wal.replayTimeMs = replayTimeMs;
    }
  }

  /**
   * Get traces for a specific operation
   */
  getOperationTraces(opId: string): OperationTrace[] {
    return this.traces.filter(t => t.opId === opId);
  }

  /**
   * Get recent traces within time window
   */
  getRecentTraces(windowMs: number = 60000): OperationTrace[] {
    const cutoff = Date.now() - windowMs;
    return this.traces.filter(t => t.timestamp > cutoff);
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics(): DistributionMetrics {
    // Calculate average latency from recent traces
    const recentTraces = this.getRecentTraces();
    const latencies = recentTraces
      .filter(t => t.duration !== undefined)
      .map(t => t.duration!);
    
    if (latencies.length > 0) {
      this.metrics.operations.averageLatencyMs = 
        latencies.reduce((sum, lat) => sum + lat, 0) / latencies.length;
    }

    return { ...this.metrics };
  }

  /**
   * Print metrics summary
   */
  printSummary(): void {
    const metrics = this.getMetrics();
    
    this.logger.info('\nDistribution Metrics Summary:');
    this.logger.info(`   Operations: ${metrics.operations.total} total, ${metrics.operations.errors} errors`);
    this.logger.info(`   Avg Latency: ${metrics.operations.averageLatencyMs.toFixed(2)}ms`);
    this.logger.info(`   Routing: ${metrics.routing.localHits} local, ${metrics.routing.remoteHits} remote, ${metrics.routing.gossipFallbacks} gossip`);
    this.logger.info(`   WAL: ${metrics.wal.entries} entries (${metrics.wal.messageRecords} msg, ${metrics.wal.membershipRecords} membership)`);
    this.logger.info(`   Queues: ${Object.keys(metrics.queues.depth).length} active, ${metrics.queues.slowConsumers.length} slow`);

    if (metrics.queues.slowConsumers.length > 0) {
      this.logger.info(`   Slow consumers: ${metrics.queues.slowConsumers.join(', ')}`);
    }
  }

  /**
   * Clear all traces and reset metrics
   */
  reset(): void {
    this.traces = [];
    this.metrics = {
      operations: {
        total: 0,
        byPhase: {},
        byNode: {},
        errors: 0,
        averageLatencyMs: 0
      },
      queues: {
        depth: {},
        drops: {},
        slowConsumers: []
      },
      routing: {
        localHits: 0,
        remoteHits: 0,
        gossipFallbacks: 0
      },
      wal: {
        entries: 0,
        messageRecords: 0,
        membershipRecords: 0,
        replayTimeMs: 0
      }
    };
  }
}
