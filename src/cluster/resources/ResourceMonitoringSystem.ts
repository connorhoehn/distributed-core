import { EventEmitter } from 'events';
import { ResourceMetadata, ResourceState, ResourceHealth } from './types';
import { ResourceRegistry } from './ResourceRegistry';
import { ClusterManager } from '../ClusterManager';

export interface HealthCheck {
  resourceId: string;
  checkId: string;
  timestamp: number;
  status: ResourceHealth;
  latency: number;
  errorMessage?: string;
  metadata?: Record<string, any>;
}

export interface PerformanceMetrics {
  resourceId: string;
  timestamp: number;
  latency: number;
  throughput: number;
  errorRate: number;
  cpuUsage?: number;
  memoryUsage?: number;
  networkIO?: number;
  diskIO?: number;
}

export interface ResourceAlert {
  alertId: string;
  resourceId: string;
  alertType: 'HEALTH' | 'PERFORMANCE' | 'CAPACITY' | 'AVAILABILITY';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  message: string;
  timestamp: number;
  acknowledged: boolean;
  metadata?: Record<string, any>;
}

/**
 * Resource monitoring and alerting system
 * Tracks resource health, performance, and generates alerts
 */
export class ResourceMonitoringSystem extends EventEmitter {
  private healthChecks = new Map<string, HealthCheck[]>(); // resourceId -> checks
  private performanceHistory = new Map<string, PerformanceMetrics[]>(); // resourceId -> metrics
  private activeAlerts = new Map<string, ResourceAlert>(); // alertId -> alert
  private monitoringInterval?: NodeJS.Timeout;
  private alertThresholds: {
    latencyThreshold: number;
    errorRateThreshold: number;
    cpuThreshold: number;
    memoryThreshold: number;
  };
  
  constructor(
    private resourceRegistry: ResourceRegistry,
    private clusterManager: ClusterManager,
    private config: {
      monitoringInterval?: number;
      healthCheckRetention?: number;
      performanceRetention?: number;
      latencyThreshold?: number;
      errorRateThreshold?: number;
      cpuThreshold?: number;
      memoryThreshold?: number;
    } = {}
  ) {
    super();
    
    this.alertThresholds = {
      latencyThreshold: config.latencyThreshold || 1000, // 1 second
      errorRateThreshold: config.errorRateThreshold || 0.05, // 5%
      cpuThreshold: config.cpuThreshold || 0.8, // 80%
      memoryThreshold: config.memoryThreshold || 0.8 // 80%
    };
    
    this.setupEventHandlers();
    this.startMonitoring(config.monitoringInterval || 30000); // 30 seconds
  }

  /**
   * Record a health check for a resource
   */
  recordHealthCheck(healthCheck: HealthCheck): void {
    if (!this.healthChecks.has(healthCheck.resourceId)) {
      this.healthChecks.set(healthCheck.resourceId, []);
    }
    
    const checks = this.healthChecks.get(healthCheck.resourceId)!;
    checks.push(healthCheck);
    
    // Keep only recent checks (last 100 per resource)
    if (checks.length > 100) {
      checks.splice(0, checks.length - 100);
    }
    
    // Check for health degradation
    this.analyzeHealthTrend(healthCheck.resourceId);
    
    this.emit('health-check', healthCheck);
    console.log(`💊 Health check for ${healthCheck.resourceId}: ${healthCheck.status} (${healthCheck.latency}ms)`);
  }

  /**
   * Record performance metrics for a resource
   */
  recordPerformanceMetrics(metrics: PerformanceMetrics): void {
    if (!this.performanceHistory.has(metrics.resourceId)) {
      this.performanceHistory.set(metrics.resourceId, []);
    }
    
    const history = this.performanceHistory.get(metrics.resourceId)!;
    history.push(metrics);
    
    // Keep only recent metrics (last 200 per resource)
    if (history.length > 200) {
      history.splice(0, history.length - 200);
    }
    
    // Check for performance issues
    this.analyzePerformanceMetrics(metrics);
    
    this.emit('performance-metrics', metrics);
  }

  /**
   * Create an alert for a resource
   */
  createAlert(alert: Omit<ResourceAlert, 'alertId' | 'timestamp' | 'acknowledged'>): string {
    const alertId = `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const fullAlert: ResourceAlert = {
      ...alert,
      alertId,
      timestamp: Date.now(),
      acknowledged: false
    };
    
    this.activeAlerts.set(alertId, fullAlert);
    
    this.emit('alert-created', fullAlert);
    console.log(`🚨 Alert created: ${fullAlert.severity} - ${fullAlert.message} (${fullAlert.resourceId})`);
    
    // Propagate critical alerts to cluster
    if (fullAlert.severity === 'CRITICAL') {
      this.propagateAlertToCluster(fullAlert);
    }
    
    return alertId;
  }

  /**
   * Acknowledge an alert
   */
  acknowledgeAlert(alertId: string, acknowledgedBy?: string): boolean {
    const alert = this.activeAlerts.get(alertId);
    if (!alert || alert.acknowledged) {
      return false;
    }
    
    alert.acknowledged = true;
    alert.metadata = {
      ...alert.metadata,
      acknowledgedBy,
      acknowledgedAt: Date.now()
    };
    
    this.emit('alert-acknowledged', alert);
    console.log(`✅ Alert acknowledged: ${alertId}`);
    
    return true;
  }

  /**
   * Get health status for a resource
   */
  getResourceHealthStatus(resourceId: string): {
    currentHealth: ResourceHealth;
    recentChecks: HealthCheck[];
    healthTrend: 'IMPROVING' | 'STABLE' | 'DEGRADING';
    averageLatency: number;
  } {
    const checks = this.healthChecks.get(resourceId) || [];
    const recentChecks = checks.slice(-10); // Last 10 checks
    
    const currentHealth = recentChecks.length > 0 
      ? recentChecks[recentChecks.length - 1].status 
      : ResourceHealth.UNKNOWN;
    
    const averageLatency = recentChecks.length > 0
      ? recentChecks.reduce((sum, check) => sum + check.latency, 0) / recentChecks.length
      : 0;
    
    // Determine trend
    let healthTrend: 'IMPROVING' | 'STABLE' | 'DEGRADING' = 'STABLE';
    if (recentChecks.length >= 5) {
      const firstHalf = recentChecks.slice(0, Math.floor(recentChecks.length / 2));
      const secondHalf = recentChecks.slice(Math.floor(recentChecks.length / 2));
      
      const firstScore = this.calculateHealthScore(firstHalf);
      const secondScore = this.calculateHealthScore(secondHalf);
      
      if (secondScore > firstScore + 0.1) {
        healthTrend = 'IMPROVING';
      } else if (secondScore < firstScore - 0.1) {
        healthTrend = 'DEGRADING';
      }
    }
    
    return {
      currentHealth,
      recentChecks,
      healthTrend,
      averageLatency
    };
  }

  /**
   * Get performance analytics for a resource
   */
  getPerformanceAnalytics(resourceId: string): {
    currentMetrics: PerformanceMetrics | null;
    averageLatency: number;
    averageThroughput: number;
    averageErrorRate: number;
    performanceTrend: 'IMPROVING' | 'STABLE' | 'DEGRADING';
    recommendations: string[];
  } {
    const history = this.performanceHistory.get(resourceId) || [];
    const currentMetrics = history.length > 0 ? history[history.length - 1] : null;
    
    if (history.length === 0) {
      return {
        currentMetrics: null,
        averageLatency: 0,
        averageThroughput: 0,
        averageErrorRate: 0,
        performanceTrend: 'STABLE',
        recommendations: ['No performance data available']
      };
    }
    
    const averageLatency = history.reduce((sum, m) => sum + m.latency, 0) / history.length;
    const averageThroughput = history.reduce((sum, m) => sum + m.throughput, 0) / history.length;
    const averageErrorRate = history.reduce((sum, m) => sum + m.errorRate, 0) / history.length;
    
    // Determine performance trend
    let performanceTrend: 'IMPROVING' | 'STABLE' | 'DEGRADING' = 'STABLE';
    if (history.length >= 10) {
      const recent = history.slice(-5);
      const older = history.slice(-10, -5);
      
      const recentScore = this.calculatePerformanceScore(recent);
      const olderScore = this.calculatePerformanceScore(older);
      
      if (recentScore > olderScore + 0.1) {
        performanceTrend = 'IMPROVING';
      } else if (recentScore < olderScore - 0.1) {
        performanceTrend = 'DEGRADING';
      }
    }
    
    // Generate recommendations
    const recommendations = this.generatePerformanceRecommendations(
      currentMetrics!, 
      averageLatency, 
      averageErrorRate
    );
    
    return {
      currentMetrics,
      averageLatency,
      averageThroughput,
      averageErrorRate,
      performanceTrend,
      recommendations
    };
  }

  /**
   * Get all active alerts
   */
  getActiveAlerts(resourceId?: string): ResourceAlert[] {
    const alerts = Array.from(this.activeAlerts.values())
      .filter(alert => !alert.acknowledged);
    
    if (resourceId) {
      return alerts.filter(alert => alert.resourceId === resourceId);
    }
    
    return alerts.sort((a, b) => {
      // Sort by severity first, then by timestamp
      const severityOrder = { 'CRITICAL': 4, 'HIGH': 3, 'MEDIUM': 2, 'LOW': 1 };
      const severityDiff = severityOrder[b.severity] - severityOrder[a.severity];
      if (severityDiff !== 0) return severityDiff;
      
      return b.timestamp - a.timestamp;
    });
  }

  /**
   * Get monitoring statistics
   */
  getMonitoringStats(): {
    totalResources: number;
    healthyResources: number;
    unhealthyResources: number;
    activeAlerts: number;
    criticalAlerts: number;
    averageClusterLatency: number;
    topPerformingResources: string[];
    worstPerformingResources: string[];
  } {
    const allResources = Array.from(this.resourceRegistry.getAllResources());
    const healthyResources = allResources.filter(r => r.health === ResourceHealth.HEALTHY).length;
    const unhealthyResources = allResources.filter(r => r.health === ResourceHealth.UNHEALTHY).length;
    
    const activeAlerts = this.getActiveAlerts();
    const criticalAlerts = activeAlerts.filter(a => a.severity === 'CRITICAL').length;
    
    // Calculate average cluster latency
    const allMetrics = Array.from(this.performanceHistory.values()).flat();
    const recentMetrics = allMetrics.filter(m => Date.now() - m.timestamp < 300000); // Last 5 minutes
    const averageClusterLatency = recentMetrics.length > 0
      ? recentMetrics.reduce((sum, m) => sum + m.latency, 0) / recentMetrics.length
      : 0;
    
    // Get top/worst performing resources
    const resourcePerformance = new Map<string, number>();
    for (const [resourceId, metrics] of this.performanceHistory) {
      const recentMetrics = metrics.filter(m => Date.now() - m.timestamp < 300000);
      if (recentMetrics.length > 0) {
        const avgLatency = recentMetrics.reduce((sum, m) => sum + m.latency, 0) / recentMetrics.length;
        const avgThroughput = recentMetrics.reduce((sum, m) => sum + m.throughput, 0) / recentMetrics.length;
        const avgErrorRate = recentMetrics.reduce((sum, m) => sum + m.errorRate, 0) / recentMetrics.length;
        
        // Performance score (higher is better)
        const score = (avgThroughput / Math.max(avgLatency, 1)) * (1 - avgErrorRate);
        resourcePerformance.set(resourceId, score);
      }
    }
    
    const sortedByPerformance = Array.from(resourcePerformance.entries())
      .sort((a, b) => b[1] - a[1]);
    
    const topPerformingResources = sortedByPerformance.slice(0, 5).map(([id]) => id);
    const worstPerformingResources = sortedByPerformance.slice(-5).reverse().map(([id]) => id);
    
    return {
      totalResources: allResources.length,
      healthyResources,
      unhealthyResources,
      activeAlerts: activeAlerts.length,
      criticalAlerts,
      averageClusterLatency,
      topPerformingResources,
      worstPerformingResources
    };
  }

  private setupEventHandlers(): void {
    // Monitor resource updates for health changes
    this.resourceRegistry.on('resource:updated', (resource: ResourceMetadata, previous?: ResourceMetadata) => {
      // Generate health check if health changed
      if (previous && previous.health !== resource.health) {
        this.recordHealthCheck({
          resourceId: resource.resourceId,
          checkId: `auto-${Date.now()}`,
          timestamp: Date.now(),
          status: resource.health,
          latency: resource.performance?.latency || 0,
          metadata: { automated: true, previousHealth: previous.health }
        });
      }
      
      // Record performance metrics if available
      if (resource.performance) {
        this.recordPerformanceMetrics({
          resourceId: resource.resourceId,
          timestamp: Date.now(),
          latency: resource.performance.latency,
          throughput: resource.performance.throughput,
          errorRate: resource.performance.errorRate
        });
      }
    });
  }

  private analyzeHealthTrend(resourceId: string): void {
    const checks = this.healthChecks.get(resourceId) || [];
    if (checks.length < 3) return;
    
    const recentChecks = checks.slice(-5);
    const unhealthyCount = recentChecks.filter(c => c.status === ResourceHealth.UNHEALTHY).length;
    
    // Create alert if resource has been unhealthy for multiple checks
    if (unhealthyCount >= 3) {
      this.createAlert({
        resourceId,
        alertType: 'HEALTH',
        severity: 'HIGH',
        message: `Resource has been unhealthy for ${unhealthyCount} consecutive checks`,
        metadata: { unhealthyCount, recentChecks: recentChecks.length }
      });
    }
  }

  private analyzePerformanceMetrics(metrics: PerformanceMetrics): void {
    // Check latency threshold
    if (metrics.latency > this.alertThresholds.latencyThreshold) {
      this.createAlert({
        resourceId: metrics.resourceId,
        alertType: 'PERFORMANCE',
        severity: 'MEDIUM',
        message: `High latency detected: ${metrics.latency}ms (threshold: ${this.alertThresholds.latencyThreshold}ms)`,
        metadata: { latency: metrics.latency, threshold: this.alertThresholds.latencyThreshold }
      });
    }
    
    // Check error rate threshold
    if (metrics.errorRate > this.alertThresholds.errorRateThreshold) {
      this.createAlert({
        resourceId: metrics.resourceId,
        alertType: 'PERFORMANCE',
        severity: 'HIGH',
        message: `High error rate detected: ${(metrics.errorRate * 100).toFixed(2)}% (threshold: ${(this.alertThresholds.errorRateThreshold * 100).toFixed(2)}%)`,
        metadata: { errorRate: metrics.errorRate, threshold: this.alertThresholds.errorRateThreshold }
      });
    }
  }

  private calculateHealthScore(checks: HealthCheck[]): number {
    if (checks.length === 0) return 0;
    
    const healthValues = {
      [ResourceHealth.HEALTHY]: 1,
      [ResourceHealth.DEGRADED]: 0.5,
      [ResourceHealth.UNHEALTHY]: 0,
      [ResourceHealth.UNKNOWN]: 0.25
    };
    
    return checks.reduce((sum, check) => sum + healthValues[check.status], 0) / checks.length;
  }

  private calculatePerformanceScore(metrics: PerformanceMetrics[]): number {
    if (metrics.length === 0) return 0;
    
    return metrics.reduce((sum, metric) => {
      // Score based on low latency, high throughput, low error rate
      const latencyScore = Math.max(0, 1 - metric.latency / 1000); // Normalize latency
      const throughputScore = Math.min(1, metric.throughput / 100); // Normalize throughput
      const errorScore = Math.max(0, 1 - metric.errorRate * 10); // Normalize error rate
      
      return sum + (latencyScore + throughputScore + errorScore) / 3;
    }, 0) / metrics.length;
  }

  private generatePerformanceRecommendations(
    current: PerformanceMetrics,
    avgLatency: number,
    avgErrorRate: number
  ): string[] {
    const recommendations: string[] = [];
    
    if (current.latency > avgLatency * 1.5) {
      recommendations.push('Consider optimizing resource processing or scaling up');
    }
    
    if (current.errorRate > avgErrorRate * 2) {
      recommendations.push('Investigate error causes and improve error handling');
    }
    
    if (current.throughput < 10) {
      recommendations.push('Low throughput detected - consider performance tuning');
    }
    
    if (current.cpuUsage && current.cpuUsage > 0.8) {
      recommendations.push('High CPU usage - consider scaling horizontally');
    }
    
    if (current.memoryUsage && current.memoryUsage > 0.8) {
      recommendations.push('High memory usage - investigate memory leaks or scale up');
    }
    
    if (recommendations.length === 0) {
      recommendations.push('Resource performance is within normal parameters');
    }
    
    return recommendations;
  }

  private startMonitoring(intervalMs: number): void {
    this.monitoringInterval = setInterval(() => {
      this.performHealthChecks();
      this.cleanupOldData();
    }, intervalMs);
  }

  private performHealthChecks(): void {
    // Perform automated health checks on all resources
    for (const resource of this.resourceRegistry.getAllResources()) {
      this.recordHealthCheck({
        resourceId: resource.resourceId,
        checkId: `auto-${Date.now()}`,
        timestamp: Date.now(),
        status: resource.health,
        latency: resource.performance?.latency || 0,
        metadata: { automated: true }
      });
    }
  }

  private cleanupOldData(): void {
    const oneHourAgo = Date.now() - 3600000;
    
    // Clean up old alerts
    for (const [alertId, alert] of this.activeAlerts) {
      if (alert.acknowledged && alert.timestamp < oneHourAgo) {
        this.activeAlerts.delete(alertId);
      }
    }
  }

  private propagateAlertToCluster(alert: ResourceAlert): void {
    const members = this.clusterManager.membership.getAllMembers()
      .filter(m => m.status === 'ALIVE' && m.id !== this.clusterManager.localNodeId);
    
    if (members.length > 0) {
      this.clusterManager.sendCustomMessage(
        'resource:alert',
        alert,
        members.map(m => m.id)
      ).catch(error => {
        console.error('Failed to propagate alert to cluster:', error);
      });
    }
  }

  /**
   * Cleanup resources when shutting down
   */
  destroy(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    this.healthChecks.clear();
    this.performanceHistory.clear();
    this.activeAlerts.clear();
    this.removeAllListeners();
  }
}
