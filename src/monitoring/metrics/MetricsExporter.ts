import { EventEmitter } from 'eventemitter3';
import { UnifiedMetrics, Alert } from './MetricsTracker';

/**
 * Export format types
 */
export type ExportFormat = 'prometheus' | 'json' | 'csv' | 'influxdb' | 'cloudwatch' | 'datadog';

/**
 * Export destination configuration
 */
export interface ExportDestination {
  type: ExportFormat;
  endpoint?: string;
  apiKey?: string;
  database?: string;
  measurement?: string;
  tags?: Record<string, string>;
  headers?: Record<string, string>;
  batchSize?: number;
  flushInterval?: number;
}

/**
 * Prometheus metric format
 */
export interface PrometheusMetric {
  name: string;
  type: 'counter' | 'gauge' | 'histogram' | 'summary';
  help: string;
  labels?: Record<string, string>;
  value: number;
  timestamp?: number;
}

/**
 * InfluxDB line protocol format
 */
export interface InfluxDBPoint {
  measurement: string;
  tags?: Record<string, string>;
  fields: Record<string, number | string | boolean>;
  timestamp?: number;
}

/**
 * CloudWatch metric format
 */
export interface CloudWatchMetric {
  MetricName: string;
  Namespace: string;
  Value: number;
  Unit: string;
  Dimensions?: Array<{ Name: string; Value: string }>;
  Timestamp?: Date;
}

export interface MetricsExporterConfig {
  destinations: ExportDestination[];
  defaultTags?: Record<string, string>;
  enableBuffering?: boolean;
  bufferSize?: number;
  flushInterval?: number;
  enableCompression?: boolean;
  retryAttempts?: number;
  retryDelay?: number;
}

/**
 * Centralized metrics export system supporting multiple formats and destinations
 */
export class MetricsExporter extends EventEmitter {
  private config: MetricsExporterConfig;
  private buffer: UnifiedMetrics[] = [];
  private alertBuffer: Alert[] = [];
  private flushTimer?: NodeJS.Timeout;
  private isExporting = false;

  constructor(config: MetricsExporterConfig) {
    super();
    this.config = {
      enableBuffering: true,
      bufferSize: 100,
      flushInterval: 30000, // 30 seconds
      enableCompression: false,
      retryAttempts: 3,
      retryDelay: 1000,
      ...config
    };

    if (this.config.enableBuffering && this.config.flushInterval) {
      this.startAutoFlush();
    }
  }

  /**
   * Export single metrics snapshot
   */
  async exportMetrics(metrics: UnifiedMetrics): Promise<void> {
    if (this.config.enableBuffering) {
      this.buffer.push(metrics);
      
      if (this.buffer.length >= (this.config.bufferSize || 100)) {
        await this.flush();
      }
    } else {
      await this.exportBatch([metrics], []);
    }
  }

  /**
   * Export alert
   */
  async exportAlert(alert: Alert): Promise<void> {
    if (this.config.enableBuffering) {
      this.alertBuffer.push(alert);
    } else {
      await this.exportBatch([], [alert]);
    }
  }

  /**
   * Export batch of metrics and alerts
   */
  async exportBatch(metrics: UnifiedMetrics[], alerts: Alert[]): Promise<void> {
    if (this.isExporting) return;
    
    this.isExporting = true;
    
    try {
      await Promise.all(
        this.config.destinations.map(destination => 
          this.exportToDestination(metrics, alerts, destination)
        )
      );
      
      this.emit('export-success', { metrics: metrics.length, alerts: alerts.length });
    } catch (error) {
      this.emit('export-error', error);
      throw error;
    } finally {
      this.isExporting = false;
    }
  }

  /**
   * Flush buffered data
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0 && this.alertBuffer.length === 0) return;
    
    const metricsToExport = [...this.buffer];
    const alertsToExport = [...this.alertBuffer];
    
    this.buffer = [];
    this.alertBuffer = [];
    
    await this.exportBatch(metricsToExport, alertsToExport);
  }

  /**
   * Start automatic flushing
   */
  private startAutoFlush(): void {
    this.flushTimer = setInterval(async () => {
      try {
        await this.flush();
      } catch (error) {
        this.emit('flush-error', error);
      }
    }, this.config.flushInterval);
    
    // Prevent timer from keeping process alive
    this.flushTimer.unref();
  }

  /**
   * Stop automatic flushing
   */
  stopAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  /**
   * Export to specific destination
   */
  private async exportToDestination(
    metrics: UnifiedMetrics[], 
    alerts: Alert[], 
    destination: ExportDestination
  ): Promise<void> {
    switch (destination.type) {
      case 'prometheus':
        await this.exportToPrometheus(metrics, destination);
        break;
      case 'json':
        await this.exportToJSON(metrics, alerts, destination);
        break;
      case 'csv':
        await this.exportToCSV(metrics, destination);
        break;
      case 'influxdb':
        await this.exportToInfluxDB(metrics, destination);
        break;
      case 'cloudwatch':
        await this.exportToCloudWatch(metrics, destination);
        break;
      case 'datadog':
        await this.exportToDatadog(metrics, destination);
        break;
      default:
        throw new Error(`Unsupported export format: ${destination.type}`);
    }
  }

  /**
   * Export to Prometheus format
   */
  private async exportToPrometheus(metrics: UnifiedMetrics[], destination: ExportDestination): Promise<void> {
    const prometheusMetrics: PrometheusMetric[] = [];

    metrics.forEach(metric => {
      const labels = { ...this.config.defaultTags, ...destination.tags };
      
      // System metrics
      prometheusMetrics.push(
        {
          name: 'system_cpu_percentage',
          type: 'gauge',
          help: 'CPU usage percentage',
          labels,
          value: metric.system.cpu.percentage,
          timestamp: metric.timestamp
        },
        {
          name: 'system_memory_percentage',
          type: 'gauge',
          help: 'Memory usage percentage',
          labels,
          value: metric.system.memory.percentage,
          timestamp: metric.timestamp
        },
        {
          name: 'system_disk_percentage',
          type: 'gauge',
          help: 'Disk usage percentage',
          labels,
          value: metric.system.disk.percentage,
          timestamp: metric.timestamp
        }
      );

      // Cluster metrics
      prometheusMetrics.push(
        {
          name: 'cluster_membership_size',
          type: 'gauge',
          help: 'Number of nodes in cluster',
          labels,
          value: metric.cluster.membershipSize,
          timestamp: metric.timestamp
        },
        {
          name: 'cluster_gossip_rate',
          type: 'gauge',
          help: 'Gossip message rate',
          labels,
          value: metric.cluster.gossipRate,
          timestamp: metric.timestamp
        },
        {
          name: 'cluster_message_latency_ms',
          type: 'gauge',
          help: 'Cluster message latency in milliseconds',
          labels,
          value: metric.cluster.messageLatency,
          timestamp: metric.timestamp
        }
      );

      // Network metrics
      prometheusMetrics.push(
        {
          name: 'network_latency_ms',
          type: 'gauge',
          help: 'Network latency in milliseconds',
          labels,
          value: metric.network.latency,
          timestamp: metric.timestamp
        },
        {
          name: 'network_active_connections',
          type: 'gauge',
          help: 'Number of active network connections',
          labels,
          value: metric.network.activeConnections,
          timestamp: metric.timestamp
        }
      );

      // Connection metrics
      prometheusMetrics.push(
        {
          name: 'connections_total_acquired',
          type: 'counter',
          help: 'Total connections acquired',
          labels,
          value: metric.connections.totalAcquired,
          timestamp: metric.timestamp
        },
        {
          name: 'connections_pool_utilization',
          type: 'gauge',
          help: 'Connection pool utilization ratio',
          labels,
          value: metric.connections.poolUtilization,
          timestamp: metric.timestamp
        }
      );
    });

    const prometheusData = this.formatPrometheusMetrics(prometheusMetrics);
    await this.sendToEndpoint(prometheusData, destination, 'text/plain');
  }

  /**
   * Export to JSON format
   */
  private async exportToJSON(metrics: UnifiedMetrics[], alerts: Alert[], destination: ExportDestination): Promise<void> {
    const jsonData = {
      timestamp: Date.now(),
      metrics,
      alerts,
      metadata: {
        source: 'distributed-core',
        version: '1.0.0',
        tags: { ...this.config.defaultTags, ...destination.tags }
      }
    };

    await this.sendToEndpoint(JSON.stringify(jsonData), destination, 'application/json');
  }

  /**
   * Export to CSV format
   */
  private async exportToCSV(metrics: UnifiedMetrics[], destination: ExportDestination): Promise<void> {
    if (metrics.length === 0) return;

    const headers = [
      'timestamp',
      'cpu_percentage',
      'memory_percentage', 
      'disk_percentage',
      'cluster_size',
      'gossip_rate',
      'message_latency',
      'network_latency',
      'active_connections',
      'pool_utilization',
      'overall_health'
    ];

    const rows = metrics.map(m => [
      new Date(m.timestamp).toISOString(),
      m.system.cpu.percentage,
      m.system.memory.percentage,
      m.system.disk.percentage,
      m.cluster.membershipSize,
      m.cluster.gossipRate,
      m.cluster.messageLatency,
      m.network.latency,
      m.network.activeConnections,
      m.connections.poolUtilization,
      m.health.overallHealth
    ]);

    const csvData = [headers, ...rows].map(row => row.join(',')).join('\n');
    await this.sendToEndpoint(csvData, destination, 'text/csv');
  }

  /**
   * Export to InfluxDB line protocol
   */
  private async exportToInfluxDB(metrics: UnifiedMetrics[], destination: ExportDestination): Promise<void> {
    const points: InfluxDBPoint[] = [];

    metrics.forEach(metric => {
      const tags = { ...this.config.defaultTags, ...destination.tags };
      
      points.push(
        {
          measurement: 'system_metrics',
          tags,
          fields: {
            cpu_percentage: metric.system.cpu.percentage,
            memory_percentage: metric.system.memory.percentage,
            disk_percentage: metric.system.disk.percentage
          },
          timestamp: metric.timestamp
        },
        {
          measurement: 'cluster_metrics',
          tags,
          fields: {
            membership_size: metric.cluster.membershipSize,
            gossip_rate: metric.cluster.gossipRate,
            message_latency: metric.cluster.messageLatency,
            network_throughput: metric.cluster.networkThroughput
          },
          timestamp: metric.timestamp
        },
        {
          measurement: 'network_metrics',
          tags,
          fields: {
            latency: metric.network.latency,
            active_connections: metric.network.activeConnections,
            failed_connections: metric.network.failedConnections
          },
          timestamp: metric.timestamp
        }
      );
    });

    const lineProtocol = this.formatInfluxDBPoints(points);
    await this.sendToEndpoint(lineProtocol, destination, 'text/plain');
  }

  /**
   * Export to AWS CloudWatch
   */
  private async exportToCloudWatch(metrics: UnifiedMetrics[], destination: ExportDestination): Promise<void> {
    const cloudWatchMetrics: CloudWatchMetric[] = [];

    metrics.forEach(metric => {
      const dimensions = Object.entries({ ...this.config.defaultTags, ...destination.tags })
        .map(([key, value]) => ({ Name: key, Value: value }));

      cloudWatchMetrics.push(
        {
          MetricName: 'CPUUtilization',
          Namespace: 'DistributedCore/System',
          Value: metric.system.cpu.percentage,
          Unit: 'Percent',
          Dimensions: dimensions,
          Timestamp: new Date(metric.timestamp)
        },
        {
          MetricName: 'MemoryUtilization',
          Namespace: 'DistributedCore/System',
          Value: metric.system.memory.percentage,
          Unit: 'Percent',
          Dimensions: dimensions,
          Timestamp: new Date(metric.timestamp)
        },
        {
          MetricName: 'ClusterSize',
          Namespace: 'DistributedCore/Cluster',
          Value: metric.cluster.membershipSize,
          Unit: 'Count',
          Dimensions: dimensions,
          Timestamp: new Date(metric.timestamp)
        }
      );
    });

    await this.sendToEndpoint(JSON.stringify({ MetricData: cloudWatchMetrics }), destination, 'application/json');
  }

  /**
   * Export to Datadog
   */
  private async exportToDatadog(metrics: UnifiedMetrics[], destination: ExportDestination): Promise<void> {
    const datadogMetrics = {
      series: [] as any[]
    };

    metrics.forEach(metric => {
      const tags = Object.entries({ ...this.config.defaultTags, ...destination.tags })
        .map(([key, value]) => `${key}:${value}`);

      datadogMetrics.series.push(
        {
          metric: 'distributed_core.system.cpu_percentage',
          points: [[Math.floor(metric.timestamp / 1000), metric.system.cpu.percentage]],
          tags,
          type: 'gauge'
        },
        {
          metric: 'distributed_core.cluster.membership_size',
          points: [[Math.floor(metric.timestamp / 1000), metric.cluster.membershipSize]],
          tags,
          type: 'gauge'
        }
      );
    });

    await this.sendToEndpoint(JSON.stringify(datadogMetrics), destination, 'application/json');
  }

  /**
   * Format Prometheus metrics
   */
  private formatPrometheusMetrics(metrics: PrometheusMetric[]): string {
    const groups = new Map<string, PrometheusMetric[]>();
    
    metrics.forEach(metric => {
      if (!groups.has(metric.name)) {
        groups.set(metric.name, []);
      }
      groups.get(metric.name)!.push(metric);
    });

    let output = '';
    
    groups.forEach((metricGroup, name) => {
      const firstMetric = metricGroup[0];
      output += `# HELP ${name} ${firstMetric.help}\n`;
      output += `# TYPE ${name} ${firstMetric.type}\n`;
      
      metricGroup.forEach(metric => {
        const labels = metric.labels 
          ? '{' + Object.entries(metric.labels).map(([k, v]) => `${k}="${v}"`).join(',') + '}'
          : '';
        const timestamp = metric.timestamp ? ` ${metric.timestamp}` : '';
        output += `${name}${labels} ${metric.value}${timestamp}\n`;
      });
      
      output += '\n';
    });

    return output;
  }

  /**
   * Format InfluxDB points to line protocol
   */
  private formatInfluxDBPoints(points: InfluxDBPoint[]): string {
    return points.map(point => {
      let line = point.measurement;
      
      if (point.tags && Object.keys(point.tags).length > 0) {
        const tags = Object.entries(point.tags)
          .map(([k, v]) => `${k}=${v}`)
          .join(',');
        line += `,${tags}`;
      }
      
      const fields = Object.entries(point.fields)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? `"${v}"` : v}`)
        .join(',');
      line += ` ${fields}`;
      
      if (point.timestamp) {
        line += ` ${point.timestamp}000000`; // Convert to nanoseconds
      }
      
      return line;
    }).join('\n');
  }

  /**
   * Send data to endpoint
   */
  private async sendToEndpoint(data: string, destination: ExportDestination, contentType: string): Promise<void> {
    if (!destination.endpoint) {
      const error = new Error(`No endpoint specified for ${destination.type}`);
      this.emit('export-error', error);
      throw error; // Also throw to propagate error up to flush()
    }

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      ...destination.headers
    };

    if (destination.apiKey) {
      headers['Authorization'] = `Bearer ${destination.apiKey}`;
    }

    // This would be implemented with actual HTTP client
    this.emit('export-attempted', {
      destination: destination.type,
      endpoint: destination.endpoint,
      dataSize: data.length
    });
    
    // Mock successful export (removed delay for fast unit tests)
  }

  /**
   * Get export statistics
   */
  getStats(): any {
    return {
      bufferSize: this.buffer.length,
      alertBufferSize: this.alertBuffer.length,
      isExporting: this.isExporting,
      destinations: this.config.destinations.length
    };
  }

  /**
   * Add destination
   */
  addDestination(destination: ExportDestination): void {
    this.config.destinations.push(destination);
    this.emit('destination-added', destination);
  }

  /**
   * Remove destination
   */
  removeDestination(type: ExportFormat, endpoint?: string): void {
    this.config.destinations = this.config.destinations.filter(d => 
      d.type !== type || (endpoint && d.endpoint !== endpoint)
    );
    this.emit('destination-removed', { type, endpoint });
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<MetricsExporterConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.emit('config-updated', this.config);
  }

  /**
   * Cleanup and stop export operations
   */
  async cleanup(): Promise<void> {
    this.stopAutoFlush();
    await this.flush(); // Final flush
    this.removeAllListeners();
  }
}
