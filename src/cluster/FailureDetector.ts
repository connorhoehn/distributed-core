import { EventEmitter } from 'events';
import { Transport } from '../transport/Transport';
import { MembershipTable } from './MembershipTable';
import { NodeInfo } from './types';

export interface FailureDetectorConfig {
  heartbeatInterval: number;    // How often to send heartbeats (ms)
  failureTimeout: number;       // When to mark node as SUSPECT (ms)
  deadTimeout: number;          // When to mark node as DEAD (ms)
  enableLogging: boolean;
}

export class FailureDetector extends EventEmitter {
  private heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private lastSeenTimestamps = new Map<string, number>();
  private monitoringTimer?: NodeJS.Timeout;
  private isRunning = false;

  private config: FailureDetectorConfig = {
    heartbeatInterval: 1000,    // 1 second heartbeats
    failureTimeout: 3000,       // 3 seconds to SUSPECT
    deadTimeout: 6000,          // 6 seconds to DEAD
    enableLogging: false
  };

  constructor(
    private localNodeId: string,
    private transport: Transport,
    private membership: MembershipTable,
    config: Partial<FailureDetectorConfig> = {}
  ) {
    super();
    this.config = { ...this.config, ...config };
    
    // Listen for membership changes
    this.membership.on('member-joined', (nodeInfo: NodeInfo) => {
      this.startMonitoring(nodeInfo.id);
    });
    
    this.membership.on('member-left', (nodeId: string) => {
      this.stopMonitoring(nodeId);
    });
  }

  /**
   * Start failure detection
   */
  start(): void {
    if (this.isRunning) return;
    
    this.isRunning = true;
    
    // Start monitoring existing members
    const members = this.membership.getAllMembers();
    for (const member of members) {
      if (member.id !== this.localNodeId) {
        this.startMonitoring(member.id);
      }
    }
    
    // Start periodic monitoring check
    this.monitoringTimer = setInterval(() => {
      this.checkForFailures();
    }, this.config.heartbeatInterval);

    if (this.config.enableLogging) {
      console.log(`FailureDetector started for node ${this.localNodeId}`);
    }
  }

  /**
   * Stop failure detection
   */
  stop(): void {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    // Clear all timers
    this.heartbeatTimers.forEach(timer => clearTimeout(timer));
    this.heartbeatTimers.clear();
    
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = undefined;
    }
    
    this.lastSeenTimestamps.clear();
    
    if (this.config.enableLogging) {
      console.log(`FailureDetector stopped for node ${this.localNodeId}`);
    }
  }

  /**
   * Record that we've seen a node (e.g., received a message from it)
   */
  recordNodeActivity(nodeId: string): void {
    if (nodeId === this.localNodeId) return;
    
    this.lastSeenTimestamps.set(nodeId, Date.now());
    
    // If the node was marked as SUSPECT or DEAD, mark it as ALIVE again
    const member = this.membership.getMember(nodeId);
    if (member && (member.status === 'SUSPECT' || member.status === 'DEAD')) {
      // Use updateNode method to update the member status
      this.membership.updateNode({
        id: nodeId,
        status: 'ALIVE',
        lastSeen: Date.now(),
        version: member.version + 1,
        metadata: member.metadata
      });
      
      if (this.config.enableLogging) {
        console.log(`Node ${nodeId} recovered and marked as ALIVE`);
      }
      
      this.emit('node-recovered', nodeId);
    }
  }

  /**
   * Manually mark a node as failed (for testing or explicit failures)
   */
  markNodeFailed(nodeId: string): boolean {
    if (nodeId === this.localNodeId) return false;
    
    const marked = this.membership.markDead(nodeId);
    if (marked && this.config.enableLogging) {
      console.log(`Node ${nodeId} manually marked as DEAD`);
    }
    
    if (marked) {
      this.emit('node-failed', nodeId);
    }
    
    return marked;
  }

  /**
   * Start monitoring a specific node
   */
  private startMonitoring(nodeId: string): void {
    if (nodeId === this.localNodeId) return;
    
    this.lastSeenTimestamps.set(nodeId, Date.now());
    
    if (this.config.enableLogging) {
      console.log(`Started monitoring node ${nodeId}`);
    }
  }

  /**
   * Stop monitoring a specific node
   */
  private stopMonitoring(nodeId: string): void {
    const timer = this.heartbeatTimers.get(nodeId);
    if (timer) {
      clearTimeout(timer);
      this.heartbeatTimers.delete(nodeId);
    }
    
    this.lastSeenTimestamps.delete(nodeId);
    
    if (this.config.enableLogging) {
      console.log(`Stopped monitoring node ${nodeId}`);
    }
  }

  /**
   * Check all monitored nodes for failures
   */
  private checkForFailures(): void {
    const now = Date.now();
    
    for (const [nodeId, lastSeen] of this.lastSeenTimestamps) {
      const timeSinceLastSeen = now - lastSeen;
      const member = this.membership.getMember(nodeId);
      
      if (!member) continue;
      
      // If node hasn't been seen for deadTimeout, mark as DEAD
      if (timeSinceLastSeen > this.config.deadTimeout && member.status !== 'DEAD') {
        this.membership.markDead(nodeId);
        
        if (this.config.enableLogging) {
          console.log(`Node ${nodeId} marked as DEAD (not seen for ${timeSinceLastSeen}ms)`);
        }
        
        this.emit('node-failed', nodeId);
      }
      // If node hasn't been seen for failureTimeout, mark as SUSPECT
      else if (timeSinceLastSeen > this.config.failureTimeout && member.status === 'ALIVE') {
        this.membership.markSuspect(nodeId, this.config.deadTimeout - this.config.failureTimeout);
        
        if (this.config.enableLogging) {
          console.log(`Node ${nodeId} marked as SUSPECT (not seen for ${timeSinceLastSeen}ms)`);
        }
        
        this.emit('node-suspected', nodeId);
      }
    }
  }

  /**
   * Get failure detection status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      monitoredNodes: Array.from(this.lastSeenTimestamps.keys()),
      config: this.config
    };
  }
}
