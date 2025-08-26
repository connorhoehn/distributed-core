import { EventEmitter } from 'events';

export class ResourceMonitoringSystem extends EventEmitter {
  private monitoringSystem: any;

  constructor(monitoringSystem?: any) {
    super();
    this.monitoringSystem = monitoringSystem;
  }

  startMonitoring() {
    // Implementation placeholder
  }

  stopMonitoring() {
    // Implementation placeholder
  }

  getResourceHealthStatus(resourceId: string): any {
    if (!this.monitoringSystem) {
      throw new Error('MonitoringSystem not available - ensure ClusterManager is configured');
    }
    return this.monitoringSystem.getResourceHealthStatus(resourceId);
  }

  getPerformanceAnalytics(resourceId: string): any {
    if (!this.monitoringSystem) {
      throw new Error('MonitoringSystem not available - ensure ClusterManager is configured');
    }
    return this.monitoringSystem.getPerformanceAnalytics(resourceId);
  }

  getActiveAlerts(resourceId?: string): any[] {
    if (!this.monitoringSystem) {
      throw new Error('MonitoringSystem not available - ensure ClusterManager is configured');
    }
    return this.monitoringSystem.getActiveAlerts(resourceId);
  }

  getMonitoringStats(): any {
    if (!this.monitoringSystem) {
      throw new Error('MonitoringSystem not available - ensure ClusterManager is configured');
    }
    return this.monitoringSystem.getMonitoringStats();
  }

  acknowledgeAlert(alertId: string, acknowledgedBy?: string): boolean {
    if (!this.monitoringSystem) {
      throw new Error('MonitoringSystem not available - ensure ClusterManager is configured');
    }
    return this.monitoringSystem.acknowledgeAlert(alertId, acknowledgedBy);
  }
}
