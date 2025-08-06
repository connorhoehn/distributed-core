import { EventEmitter } from 'eventemitter3';
import { PerformanceMetrics as DiagnosticMetrics } from '../../diagnostics/DiagnosticTool';
import { PerformanceMetrics as ClusterMetrics } from '../../cluster/introspection/ClusterIntrospection';
import { NodeHealthStatus } from '../../monitoring/FailureDetector';
import { ConnectionStats } from '../../connections/types';
import { PoolStats } from '../../connections/ConnectionPool';

/**
 * Unified metrics interface combining all system metrics
 */
export interface UnifiedMetrics {
  timestamp: number;
  system: SystemMetrics;
  cluster: ClusterPerformanceMetrics;
  network: NetworkMetrics;
  connections: ConnectionMetrics;
  health: HealthMetrics;
}

export interface SystemMetrics {
  cpu: {
    percentage: number;
    loadAverage?: number[];
  };
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  disk: {
    used: number;
    available: number;
    total: number;
    percentage: number;
  };
}

export interface ClusterPerformanceMetrics {
  membershipSize: number;
  gossipRate: number;
  failureDetectionLatency: number;
  averageHeartbeatInterval: number;
  messageRate: number;
  messageLatency: number;
  networkThroughput: number;
  activeFaults?: number;
  clusterStability: 'stable' | 'degraded' | 'unstable';
}

export interface NetworkMetrics {
  latency: number;
  status: 'connected' | 'degraded' | 'disconnected';
  roundTripTimes: Map<string, number>;
  failedConnections: number;
  activeConnections: number;
  bandwidth?: {
    inbound: number;
    outbound: number;
  };
}

export interface ConnectionMetrics {
  totalAcquired: number;
  totalReleased: number;
  totalCreated: number;
  totalDestroyed: number;
  activeConnections: number;
  poolUtilization: number;
  averageAcquireTime: number;
  connectionHealth: 'healthy' | 'degraded' | 'critical';
}

export interface HealthMetrics {
  overallHealth: 'healthy' | 'degraded' | 'critical';
  nodeHealth: Map<string, NodeHealthStatus>;
  systemAlerts: Alert[];
  performanceTrends: {
    cpu: TrendDirection;
    memory: TrendDirection;
    network: TrendDirection;
  };
}

export interface Alert {
  id: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  timestamp: number;
  source: string;
  metadata?: Record<string, any>;
}

export type TrendDirection = 'improving' | 'stable' | 'degrading';

export interface MetricsTrackerConfig {
  collectionInterval: number;
  retentionPeriod: number;
  enableTrends: boolean;
  enableAlerts: boolean;
  thresholds: {
    cpu: number;
    memory: number;
    disk: number;
    networkLatency: number;
    clusterStability: number;
  };
  alertHandlers?: Array<(alert: Alert) => void>;
}

/**
 * Central metrics tracking and aggregation system
 */
export class MetricsTracker extends EventEmitter {
  private config: MetricsTrackerConfig;
  private metricsHistory: UnifiedMetrics[] = [];
  private alerts: Alert[] = [];
  private collectionTimer?: NodeJS.Timeout;
  private isCollecting = false;
  
  // Metric source providers
  private diagnosticTool?: any;
  private clusterIntrospection?: any;
  private failureDetector?: any;
  private connectionManager?: any;
  private connectionPools: any[] = [];

  constructor(config: Partial<MetricsTrackerConfig> = {}) {
    super();
    
    this.config = {
      collectionInterval: config.collectionInterval ?? 30000, // 30 seconds
      retentionPeriod: config.retentionPeriod ?? 3600000, // 1 hour
      enableTrends: config.enableTrends ?? true,
      enableAlerts: config.enableAlerts ?? true,
      thresholds: {
        cpu: 85,
        memory: 90,
        disk: 95,
        networkLatency: 1000,
        clusterStability: 0.8,
        ...config.thresholds
      },
      alertHandlers: config.alertHandlers ?? []
    };
  }

  /**
   * Register metric source providers
   */
  registerDiagnosticTool(diagnosticTool: any): void {
    this.diagnosticTool = diagnosticTool;
  }

  registerClusterIntrospection(clusterIntrospection: any): void {
    this.clusterIntrospection = clusterIntrospection;
  }

  registerFailureDetector(failureDetector: any): void {
    this.failureDetector = failureDetector;
  }

  registerConnectionManager(connectionManager: any): void {
    this.connectionManager = connectionManager;
  }

  registerConnectionPool(connectionPool: any): void {
    this.connectionPools.push(connectionPool);
  }

  /**
   * Start continuous metrics collection
   */
  async startCollection(): Promise<void> {
    if (this.isCollecting) return;
    
    this.isCollecting = true;
    await this.collectMetrics(); // Initial collection
    
    this.collectionTimer = setInterval(async () => {
      try {
        await this.collectMetrics();
      } catch (error) {
        this.emit('error', new Error(`Metrics collection failed: ${error}`));
      }
    }, this.config.collectionInterval);
    
    // Prevent timer from keeping process alive
    this.collectionTimer.unref();
    
    this.emit('collection-started');
  }

  /**
   * Stop metrics collection
   */
  stopCollection(): void {
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
      this.collectionTimer = undefined;
    }
    this.isCollecting = false;
    this.emit('collection-stopped');
  }

  /**
   * Collect unified metrics from all sources
   */
  async collectMetrics(): Promise<UnifiedMetrics> {
    const timestamp = Date.now();
    
    const [systemMetrics, clusterMetrics, networkMetrics, connectionMetrics, healthMetrics] = 
      await Promise.all([
        this.collectSystemMetrics(),
        this.collectClusterMetrics(),
        this.collectNetworkMetrics(),
        this.collectConnectionMetrics(),
        this.collectHealthMetrics()
      ]);

    const unifiedMetrics: UnifiedMetrics = {
      timestamp,
      system: systemMetrics,
      cluster: clusterMetrics,
      network: networkMetrics,
      connections: connectionMetrics,
      health: healthMetrics
    };

    // Store metrics
    this.metricsHistory.push(unifiedMetrics);
    this.cleanupOldMetrics();

    // Check for alerts
    if (this.config.enableAlerts) {
      await this.checkAlerts(unifiedMetrics);
    }

    // Calculate trends
    if (this.config.enableTrends) {
      this.updateTrends();
    }

    this.emit('metrics-collected', unifiedMetrics);
    return unifiedMetrics;
  }

  /**
   * Collect system-level metrics
   */
  private async collectSystemMetrics(): Promise<SystemMetrics> {
    if (this.diagnosticTool) {
      try {
        const diagnosticMetrics: DiagnosticMetrics = await this.diagnosticTool.collectPerformanceMetrics();
        return {
          cpu: diagnosticMetrics.cpu,
          memory: diagnosticMetrics.memory,
          disk: diagnosticMetrics.disk
        };
      } catch (error) {
        this.emit('error', new Error(`Failed to collect system metrics: ${error}`));
      }
    }

    // Fallback to mock data
    return {
      cpu: { percentage: Math.random() * 100 },
      memory: { used: 0, total: 0, percentage: 0 },
      disk: { used: 0, available: 0, total: 0, percentage: 0 }
    };
  }

  /**
   * Collect cluster performance metrics
   */
  private async collectClusterMetrics(): Promise<ClusterPerformanceMetrics> {
    if (this.clusterIntrospection) {
      try {
        const clusterMetrics: ClusterMetrics = await this.clusterIntrospection.getPerformanceMetrics();
        
        // Determine cluster stability
        const stability = this.calculateClusterStability(clusterMetrics);
        
        return {
          membershipSize: clusterMetrics.membershipSize || 0,
          gossipRate: clusterMetrics.gossipRate || 0,
          failureDetectionLatency: clusterMetrics.failureDetectionLatency || 0,
          averageHeartbeatInterval: clusterMetrics.averageHeartbeatInterval || 0,
          messageRate: clusterMetrics.messageRate || 0,
          messageLatency: clusterMetrics.messageLatency || 0,
          networkThroughput: clusterMetrics.networkThroughput || 0,
          clusterStability: stability
        };
      } catch (error) {
        this.emit('error', new Error(`Failed to collect cluster metrics: ${error}`));
      }
    }

    return {
      membershipSize: 0,
      gossipRate: 0,
      failureDetectionLatency: 0,
      averageHeartbeatInterval: 0,
      messageRate: 0,
      messageLatency: 0,
      networkThroughput: 0,
      clusterStability: 'stable'
    };
  }

  /**
   * Collect network metrics
   */
  private async collectNetworkMetrics(): Promise<NetworkMetrics> {
    let roundTripTimes = new Map<string, number>();
    let activeConnections = 0;
    let failedConnections = 0;
    let averageLatency = 0;

    if (this.failureDetector) {
      try {
        // Collect round-trip times from failure detector
        const healthStatuses = this.failureDetector.getAllNodeHealth?.() || [];
        healthStatuses.forEach((status: NodeHealthStatus) => {
          if (status.roundTripTime) {
            roundTripTimes.set(status.nodeId, status.roundTripTime);
          }
          if (status.isResponsive) {
            activeConnections++;
          } else {
            failedConnections++;
          }
        });

        // Calculate average latency
        const latencies = Array.from(roundTripTimes.values());
        averageLatency = latencies.length > 0 
          ? latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length 
          : 0;
      } catch (error) {
        this.emit('error', new Error(`Failed to collect network metrics: ${error}`));
      }
    }

    const status = failedConnections > activeConnections ? 'degraded' 
      : failedConnections > 0 ? 'degraded' : 'connected';

    return {
      latency: averageLatency,
      status,
      roundTripTimes,
      failedConnections,
      activeConnections
    };
  }

  /**
   * Collect connection pool metrics
   */
  private async collectConnectionMetrics(): Promise<ConnectionMetrics> {
    let totalStats = {
      totalAcquired: 0,
      totalReleased: 0,
      totalCreated: 0,
      totalDestroyed: 0,
      activeConnections: 0,
      acquireTimes: [] as number[]
    };

    // Aggregate from all connection pools
    this.connectionPools.forEach(pool => {
      try {
        const stats = pool.getStats?.();
        if (stats) {
          totalStats.totalAcquired += stats.totalAcquired || 0;
          totalStats.totalReleased += stats.totalReleased || 0;
          totalStats.totalCreated += stats.totalCreated || 0;
          totalStats.totalDestroyed += stats.totalDestroyed || 0;
          totalStats.activeConnections += stats.activeConnections || 0;
          if (stats.acquireTimes) {
            totalStats.acquireTimes.push(...stats.acquireTimes);
          }
        }
      } catch (error) {
        this.emit('error', new Error(`Failed to collect pool stats: ${error}`));
      }
    });

    // Calculate metrics
    const averageAcquireTime = totalStats.acquireTimes.length > 0
      ? totalStats.acquireTimes.reduce((sum, time) => sum + time, 0) / totalStats.acquireTimes.length
      : 0;

    const poolUtilization = totalStats.totalCreated > 0
      ? totalStats.activeConnections / totalStats.totalCreated
      : 0;

    const connectionHealth = poolUtilization > 0.9 ? 'critical'
      : poolUtilization > 0.7 ? 'degraded' : 'healthy';

    return {
      totalAcquired: totalStats.totalAcquired,
      totalReleased: totalStats.totalReleased,
      totalCreated: totalStats.totalCreated,
      totalDestroyed: totalStats.totalDestroyed,
      activeConnections: totalStats.activeConnections,
      poolUtilization,
      averageAcquireTime,
      connectionHealth
    };
  }

  /**
   * Collect health metrics and determine overall system health
   */
  private async collectHealthMetrics(): Promise<HealthMetrics> {
    const nodeHealth = new Map<string, NodeHealthStatus>();
    
    if (this.failureDetector) {
      try {
        const healthStatuses = this.failureDetector.getAllNodeHealth?.() || [];
        healthStatuses.forEach((status: NodeHealthStatus) => {
          nodeHealth.set(status.nodeId, status);
        });
      } catch (error) {
        this.emit('error', new Error(`Failed to collect health metrics: ${error}`));
      }
    }

    // Determine overall health
    const overallHealth = this.calculateOverallHealth(nodeHealth);

    // Calculate performance trends
    const performanceTrends = this.calculatePerformanceTrends();

    return {
      overallHealth,
      nodeHealth,
      systemAlerts: [...this.alerts],
      performanceTrends
    };
  }

  /**
   * Calculate cluster stability based on metrics
   */
  private calculateClusterStability(metrics: ClusterMetrics): 'stable' | 'degraded' | 'unstable' {
    const stabilityScore = (
      (metrics.gossipRate > 0 ? 1 : 0) +
      (metrics.failureDetectionLatency < 5000 ? 1 : 0) +
      (metrics.messageLatency < 1000 ? 1 : 0)
    ) / 3;

    if (stabilityScore >= this.config.thresholds.clusterStability) return 'stable';
    if (stabilityScore >= 0.5) return 'degraded';
    return 'unstable';
  }

  /**
   * Calculate overall system health
   */
  private calculateOverallHealth(nodeHealth: Map<string, NodeHealthStatus>): 'healthy' | 'degraded' | 'critical' {
    if (nodeHealth.size === 0) return 'healthy';

    const healthyNodes = Array.from(nodeHealth.values()).filter(n => n.isResponsive).length;
    const healthRatio = healthyNodes / nodeHealth.size;

    if (healthRatio >= 0.8) return 'healthy';
    if (healthRatio >= 0.5) return 'degraded';
    return 'critical';
  }

  /**
   * Calculate performance trends
   */
  private calculatePerformanceTrends(): { cpu: TrendDirection; memory: TrendDirection; network: TrendDirection } {
    if (this.metricsHistory.length < 2) {
      return { cpu: 'stable', memory: 'stable', network: 'stable' };
    }

    const recent = this.metricsHistory.slice(-5); // Last 5 measurements
    const cpu = this.calculateTrend(recent.map(m => m.system.cpu.percentage));
    const memory = this.calculateTrend(recent.map(m => m.system.memory.percentage));
    const network = this.calculateTrend(recent.map(m => m.network.latency));

    return { cpu, memory, network };
  }

  /**
   * Calculate trend direction for a series of values
   */
  private calculateTrend(values: number[]): TrendDirection {
    if (values.length < 2) return 'stable';

    const first = values[0];
    const last = values[values.length - 1];
    const change = (last - first) / first;

    if (Math.abs(change) < 0.1) return 'stable';
    return change > 0 ? 'degrading' : 'improving';
  }

  /**
   * Check for alert conditions
   */
  private async checkAlerts(metrics: UnifiedMetrics): Promise<void> {
    const alerts: Alert[] = [];

    // System alerts
    if (metrics.system.cpu.percentage > this.config.thresholds.cpu) {
      alerts.push(this.createAlert('cpu-high', 'warning', `CPU usage is ${metrics.system.cpu.percentage.toFixed(1)}%`, 'system'));
    }

    if (metrics.system.memory.percentage > this.config.thresholds.memory) {
      alerts.push(this.createAlert('memory-high', 'warning', `Memory usage is ${metrics.system.memory.percentage.toFixed(1)}%`, 'system'));
    }

    if (metrics.system.disk.percentage > this.config.thresholds.disk) {
      alerts.push(this.createAlert('disk-high', 'error', `Disk usage is ${metrics.system.disk.percentage.toFixed(1)}%`, 'system'));
    }

    // Network alerts
    if (metrics.network.latency > this.config.thresholds.networkLatency) {
      alerts.push(this.createAlert('network-latency', 'warning', `Network latency is ${metrics.network.latency}ms`, 'network'));
    }

    // Cluster alerts
    if (metrics.cluster.clusterStability === 'unstable') {
      alerts.push(this.createAlert('cluster-unstable', 'critical', 'Cluster is in unstable state', 'cluster'));
    }

    // Connection alerts
    if (metrics.connections.connectionHealth === 'critical') {
      alerts.push(this.createAlert('connections-critical', 'critical', 'Connection pool utilization is critical', 'connections'));
    }

    // Store and emit alerts
    this.alerts.push(...alerts);
    this.cleanupOldAlerts();

    alerts.forEach(alert => {
      this.emit('alert', alert);
      this.config.alertHandlers?.forEach(handler => handler(alert));
    });
  }

  /**
   * Create a new alert
   */
  private createAlert(id: string, severity: Alert['severity'], message: string, source: string): Alert {
    return {
      id: `${id}-${Date.now()}`,
      severity,
      message,
      timestamp: Date.now(),
      source
    };
  }

  /**
   * Clean up old metrics based on retention period
   */
  private cleanupOldMetrics(): void {
    const cutoff = Date.now() - this.config.retentionPeriod;
    this.metricsHistory = this.metricsHistory.filter(m => m.timestamp > cutoff);
  }

  /**
   * Clean up old alerts (keep last 100)
   */
  private cleanupOldAlerts(): void {
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(-100);
    }
  }

  /**
   * Update performance trends
   */
  private updateTrends(): void {
    // This would be implemented based on specific trending requirements
    this.emit('trends-updated');
  }

  // Public API methods

  /**
   * Get current unified metrics
   */
  getCurrentMetrics(): UnifiedMetrics | null {
    return this.metricsHistory.length > 0 ? this.metricsHistory[this.metricsHistory.length - 1] : null;
  }

  /**
   * Get metrics history
   */
  getMetricsHistory(limit?: number): UnifiedMetrics[] {
    return limit ? this.metricsHistory.slice(-limit) : [...this.metricsHistory];
  }

  /**
   * Get recent alerts
   */
  getRecentAlerts(limit: number = 50): Alert[] {
    return this.alerts.slice(-limit);
  }

  /**
   * Get system summary
   */
  getSystemSummary(): any {
    const current = this.getCurrentMetrics();
    if (!current) return null;

    return {
      timestamp: current.timestamp,
      overallHealth: current.health.overallHealth,
      systemLoad: {
        cpu: current.system.cpu.percentage,
        memory: current.system.memory.percentage,
        disk: current.system.disk.percentage
      },
      cluster: {
        nodes: current.cluster.membershipSize,
        stability: current.cluster.clusterStability,
        messageRate: current.cluster.messageRate
      },
      network: {
        status: current.network.status,
        latency: current.network.latency,
        activeConnections: current.network.activeConnections
      },
      alerts: this.alerts.filter(a => Date.now() - a.timestamp < 300000).length // Last 5 minutes
    };
  }

  /**
   * Reset all metrics and alerts
   */
  reset(): void {
    this.metricsHistory = [];
    this.alerts = [];
    this.emit('reset');
  }

  /**
   * Get configuration
   */
  getConfig(): MetricsTrackerConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<MetricsTrackerConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.emit('config-updated', this.config);
  }

  /**
   * Track unified metrics - Used by ProductionScaleResourceManager
   * @param metrics - The unified metrics to track
   */
  trackUnified(metrics: UnifiedMetrics): void {
    this.metricsHistory.push(metrics);
    
    // Trim history to retention period (convert milliseconds to count)
    const maxHistoryItems = Math.floor(this.config.retentionPeriod / this.config.collectionInterval);
    if (this.metricsHistory.length > maxHistoryItems) {
      this.metricsHistory = this.metricsHistory.slice(-maxHistoryItems);
    }

    // Check for alerts based on the new metrics
    this.checkMetricsAlerts(metrics);
    
    // Emit metrics event for listeners
    this.emit('metrics-tracked', metrics);
  }

  /**
   * Increment a counter metric - Used by ProductionScaleResourceManager
   * @param counterName - Name of the counter to increment
   * @param value - Value to increment by (default: 1)
   * @param tags - Optional tags for the counter
   */
  incrementCounter(counterName: string, value: number = 1, tags?: Record<string, string>): void {
    const timestamp = Date.now();
    
    // Create a counter event
    const counterEvent = {
      type: 'counter',
      name: counterName,
      value,
      tags,
      timestamp
    };

    // Emit counter event for listeners
    this.emit('counter-incremented', counterEvent);
    
    // If this is a resource-related counter, track it in current metrics
    const currentMetrics = this.getCurrentMetrics();
    if (currentMetrics) {
      // Add counter data to the metrics for persistence
      (currentMetrics as any).counters = (currentMetrics as any).counters || {};
      (currentMetrics as any).counters[counterName] = 
        ((currentMetrics as any).counters[counterName] || 0) + value;
    }
  }

  /**
   * Get gauge value - Used by ProductionScaleResourceManager
   * @param gaugeName - Name of the gauge metric
   * @param tags - Optional tags to filter by
   * @returns Current gauge value or undefined if not found
   */
  getGaugeValue(gaugeName: string, tags?: Record<string, string>): number | undefined {
    const currentMetrics = this.getCurrentMetrics();
    if (!currentMetrics) return undefined;

    // Simple implementation - look in current metrics or return default
    const gauges = (currentMetrics as any).gauges || {};
    
    if (tags) {
      // If tags are provided, look for specific gauge with those tags
      const taggedKey = `${gaugeName}_${Object.entries(tags).map(([k, v]) => `${k}:${v}`).join('_')}`;
      return gauges[taggedKey];
    }
    
    return gauges[gaugeName];
  }

  /**
   * Set gauge value - Used by ProductionScaleResourceManager
   * @param gaugeName - Name of the gauge to set
   * @param value - Value to set
   * @param tags - Optional tags for the gauge
   */
  setGauge(gaugeName: string, value: number, tags?: Record<string, string>): void {
    const timestamp = Date.now();
    
    // Create a gauge event
    const gaugeEvent = {
      type: 'gauge',
      name: gaugeName,
      value,
      tags,
      timestamp
    };

    // Emit gauge event for listeners
    this.emit('gauge-set', gaugeEvent);
    
    // Store in current metrics
    const currentMetrics = this.getCurrentMetrics();
    if (currentMetrics) {
      (currentMetrics as any).gauges = (currentMetrics as any).gauges || {};
      
      if (tags) {
        const taggedKey = `${gaugeName}_${Object.entries(tags).map(([k, v]) => `${k}:${v}`).join('_')}`;
        (currentMetrics as any).gauges[taggedKey] = value;
      } else {
        (currentMetrics as any).gauges[gaugeName] = value;
      }
    }
  }

  /**
   * Check metrics against alert thresholds and create alerts if needed
   */
  private checkMetricsAlerts(metrics: UnifiedMetrics): void {
    if (!this.config.enableAlerts) {
      return;
    }

    const alerts: Alert[] = [];

    // CPU alert
    if (metrics.system.cpu.percentage > this.config.thresholds.cpu) {
      alerts.push({
        id: `cpu-${Date.now()}`,
        severity: 'warning',
        message: `High CPU usage: ${metrics.system.cpu.percentage.toFixed(2)}%`,
        timestamp: metrics.timestamp,
        source: 'MetricsTracker'
      });
    }

    // Memory alert
    if (metrics.system.memory.percentage > this.config.thresholds.memory) {
      alerts.push({
        id: `memory-${Date.now()}`,
        severity: 'warning',
        message: `High memory usage: ${metrics.system.memory.percentage.toFixed(2)}%`,
        timestamp: metrics.timestamp,
        source: 'MetricsTracker'
      });
    }

    // Disk alert
    if (metrics.system.disk.percentage > this.config.thresholds.disk) {
      alerts.push({
        id: `disk-${Date.now()}`,
        severity: 'warning',
        message: `High disk usage: ${metrics.system.disk.percentage.toFixed(2)}%`,
        timestamp: metrics.timestamp,
        source: 'MetricsTracker'
      });
    }

    // Network latency alert (check if network metrics have latency info)
    if ((metrics.network as any).latency && 
        (metrics.network as any).latency > this.config.thresholds.networkLatency) {
      alerts.push({
        id: `network-latency-${Date.now()}`,
        severity: 'error',
        message: `High network latency: ${((metrics.network as any).latency).toFixed(2)}ms`,
        timestamp: metrics.timestamp,
        source: 'MetricsTracker'
      });
    }

    // Add new alerts
    this.alerts.push(...alerts);
    
    // Trim alerts to retention period
    const maxAlertItems = Math.floor(this.config.retentionPeriod / this.config.collectionInterval);
    if (this.alerts.length > maxAlertItems) {
      this.alerts = this.alerts.slice(-maxAlertItems);
    }

    // Emit alerts and call alert handlers
    alerts.forEach(alert => {
      this.emit('alert', alert);
      if (this.config.alertHandlers) {
        this.config.alertHandlers.forEach(handler => handler(alert));
      }
    });
  }
}
