import { EventEmitter } from 'events';
import { Transport } from '../transport/Transport';
import { MembershipTable } from '../cluster/membership/MembershipTable';
import { NodeStatus } from '../types';
import { NodeInfo } from '../types';
import { Message, MessageType, NodeId } from '../types';

export interface FailureDetectorConfig {
  heartbeatInterval: number;    // How often to send heartbeats (ms)
  failureTimeout: number;       // When to mark node as SUSPECT (ms)
  deadTimeout: number;          // When to mark node as DEAD (ms)
  pingTimeout: number;          // How long to wait for ping response (ms)
  maxMissedHeartbeats: number;  // Number of missed heartbeats before SUSPECT
  maxMissedPings: number;       // Number of missed pings before DEAD
  enableActiveProbing: boolean; // Whether to send active ping probes
  enableLogging: boolean;
}

export interface HeartbeatData {
  type: 'HEARTBEAT' | 'PING' | 'PONG';
  targetNodeId?: string;
  sequenceNumber: number;
  payload?: any;
}

export interface NodeHealthStatus {
  nodeId: string;
  status: NodeStatus;
  lastHeartbeat: number;
  lastPing: number;
  lastPong: number;
  missedHeartbeats: number;
  missedPings: number;
  roundTripTime?: number;
  isResponsive: boolean;
}

export class FailureDetector extends EventEmitter {
  private heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private pingTimers = new Map<string, NodeJS.Timeout>();
  private lastSeenTimestamps = new Map<string, number>();
  private lastPingTimestamps = new Map<string, number>();
  private lastPongTimestamps = new Map<string, number>();
  private missedHeartbeats = new Map<string, number>();
  private missedPings = new Map<string, number>();
  private pendingPings = new Map<string, { timestamp: number; sequenceNumber: number }>();
  private sequenceNumbers = new Map<string, number>();
  private roundTripTimes = new Map<string, number>();
  
  private monitoringTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private isRunning = false;
  private localSequenceNumber = 0;

  private config: FailureDetectorConfig = {
    heartbeatInterval: 1000,      // 1 second heartbeats
    failureTimeout: 3000,         // 3 seconds to SUSPECT
    deadTimeout: 6000,            // 6 seconds to DEAD
    pingTimeout: 2000,            // 2 seconds ping timeout
    maxMissedHeartbeats: 3,       // 3 missed heartbeats = SUSPECT
    maxMissedPings: 2,            // 2 missed pings = DEAD
    enableActiveProbing: true,    // Enable ping/pong probes
    enableLogging: false
  };

  constructor(
    private localNodeId: string,
    private localNode: NodeId,
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

    // Listen for heartbeat/ping messages from transport
    this.transport.onMessage((message: Message) => {
      if (this.isHeartbeatMessage(message)) {
        this.handleHeartbeatMessage(message);
      }
    });
  }

  /**
   * Check if message is a heartbeat/ping/pong message
   */
  private isHeartbeatMessage(message: Message): boolean {
    return message.type === MessageType.FAILURE_DETECTION &&
           message.data &&
           typeof message.data.type === 'string' &&
           ['HEARTBEAT', 'PING', 'PONG'].includes(message.data.type) &&
           typeof message.data.sequenceNumber === 'number';
  }

  /**
   * Handle incoming heartbeat/ping/pong messages
   */
  private handleHeartbeatMessage(message: Message): void {
    const data = message.data as HeartbeatData;
    const sourceNodeId = message.sender.id;

    // Ignore messages from ourselves
    if (sourceNodeId === this.localNodeId) {
      return;
    }

    switch (data.type) {
      case 'HEARTBEAT':
        this.handleHeartbeat(sourceNodeId, message.timestamp, data.sequenceNumber);
        break;
      
      case 'PING':
        this.handlePing(sourceNodeId, data.targetNodeId, message.timestamp, data.sequenceNumber);
        break;
      
      case 'PONG':
        this.handlePong(sourceNodeId, message.timestamp, data.sequenceNumber);
        break;
    }
  }

  /**
   * Handle incoming heartbeat
   */
  private handleHeartbeat(sourceNodeId: string, timestamp: number, sequenceNumber: number): void {
    if (this.config.enableLogging) {
      console.log(`[FailureDetector] Received heartbeat from ${sourceNodeId} (seq: ${sequenceNumber})`);
    }

    this.recordNodeActivity(sourceNodeId);
    this.sequenceNumbers.set(sourceNodeId, sequenceNumber);
  }

  /**
   * Handle incoming ping
   */
  private handlePing(sourceNodeId: string, targetNodeId: string | undefined, timestamp: number, sequenceNumber: number): void {
    // If ping is for us, respond with pong
    if (targetNodeId === this.localNodeId) {
      if (this.config.enableLogging) {
        console.log(`[FailureDetector] Received ping from ${sourceNodeId}, sending pong`);
      }

      const pongMessage: Message = {
        id: `pong-${Date.now()}-${Math.random()}`,
        type: MessageType.FAILURE_DETECTION,
        data: {
          type: 'PONG',
          sequenceNumber: sequenceNumber
        } as HeartbeatData,
        sender: this.localNode,
        timestamp: Date.now()
      };

      // Find the sender's NodeId 
      const targetNode = this.findNodeById(sourceNodeId);
      if (targetNode) {
        this.transport.send(pongMessage, targetNode);
      }
    }

    // Record activity regardless
    this.recordNodeActivity(sourceNodeId);
  }

  /**
   * Find NodeId by string id
   */
  private findNodeById(nodeId: string): NodeId | null {
    const member = this.membership.getMember(nodeId);
    if (member && member.metadata?.address && member.metadata?.port) {
      return {
        id: nodeId,
        address: member.metadata.address,
        port: member.metadata.port
      };
    }
    return null;
  }

  /**
   * Handle incoming pong
   */
  private handlePong(sourceNodeId: string, timestamp: number, sequenceNumber: number): void {
    const now = Date.now();
    const pending = this.pendingPings.get(sourceNodeId);

    if (pending && pending.sequenceNumber === sequenceNumber) {
      const roundTripTime = now - pending.timestamp;
      this.roundTripTimes.set(sourceNodeId, roundTripTime);
      this.pendingPings.delete(sourceNodeId);

      if (this.config.enableLogging) {
        console.log(`[FailureDetector] Received pong from ${sourceNodeId} (RTT: ${roundTripTime}ms)`);
      }
    }

    this.lastPongTimestamps.set(sourceNodeId, now);
    this.recordNodeActivity(sourceNodeId);
  }

  /**
   * Start failure detection
   */
  start(): void {
    if (this.isRunning) return;
    
    this.isRunning = true;
    
    if (this.config.enableLogging) {
      console.log(`[FailureDetector] Starting failure detection for node ${this.localNodeId}`);
    }

    // Start monitoring existing members
    const members = this.membership.getAllMembers();
    for (const member of members) {
      if (member.id !== this.localNodeId) {
        this.startMonitoring(member.id);
      }
    }
    
    // Start periodic heartbeat broadcasts
    this.startHeartbeatBroadcast();

    // Start periodic failure checking
    this.monitoringTimer = setInterval(() => {
      this.checkForFailures();
    }, this.config.heartbeatInterval);
    
    // Prevent timer from keeping process alive
    this.monitoringTimer.unref();
  }

  /**
   * Stop failure detection
   */
  stop(): void {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    if (this.config.enableLogging) {
      console.log(`[FailureDetector] Stopping failure detection for node ${this.localNodeId}`);
    }

    // Clear all timers
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = undefined;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    this.heartbeatTimers.forEach(timer => clearTimeout(timer));
    this.heartbeatTimers.clear();
    
    this.pingTimers.forEach(timer => clearTimeout(timer));
    this.pingTimers.clear();

    // Clear all state
    this.lastSeenTimestamps.clear();
    this.lastPingTimestamps.clear();
    this.lastPongTimestamps.clear();
    this.missedHeartbeats.clear();
    this.missedPings.clear();
    this.pendingPings.clear();
    this.sequenceNumbers.clear();
    this.roundTripTimes.clear();
  }

  /**
   * Start periodic heartbeat broadcasts
   */
  private startHeartbeatBroadcast(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      this.broadcastHeartbeat();
    }, this.config.heartbeatInterval);
    
    // Prevent timer from keeping process alive
    this.heartbeatTimer.unref();

    // Send initial heartbeat immediately
    this.broadcastHeartbeat();
  }

  /**
   * Broadcast heartbeat to all known members
   */
  private broadcastHeartbeat(): void {
    if (!this.isRunning) return;

    const heartbeatMessage: Message = {
      id: `heartbeat-${Date.now()}-${Math.random()}`,
      type: MessageType.FAILURE_DETECTION,
      data: {
        type: 'HEARTBEAT',
        sequenceNumber: ++this.localSequenceNumber
      } as HeartbeatData,
      sender: this.localNode,
      timestamp: Date.now()
    };

    const members = this.membership.getAllMembers();
    for (const member of members) {
      if (member.id !== this.localNodeId) {
        const targetNode = this.findNodeById(member.id);
        if (targetNode) {
          this.transport.send(heartbeatMessage, targetNode);
        }
      }
    }

    if (this.config.enableLogging) {
      console.log(`[FailureDetector] Broadcasted heartbeat (seq: ${this.localSequenceNumber}) to ${members.length - 1} nodes`);
    }
  }

  /**
   * Send active ping probe to a specific node
   */
  private sendPing(nodeId: string): void {
    if (!this.isRunning || nodeId === this.localNodeId) return;

    const sequenceNumber = (this.sequenceNumbers.get(nodeId) || 0) + 1;
    this.sequenceNumbers.set(nodeId, sequenceNumber);

    const pingMessage: Message = {
      id: `ping-${Date.now()}-${Math.random()}`,
      type: MessageType.FAILURE_DETECTION,
      data: {
        type: 'PING',
        targetNodeId: nodeId,
        sequenceNumber: sequenceNumber
      } as HeartbeatData,
      sender: this.localNode,
      timestamp: Date.now()
    };

    // Track pending ping
    this.pendingPings.set(nodeId, {
      timestamp: Date.now(),
      sequenceNumber: sequenceNumber
    });

    // Set timeout for ping response
    const pingTimer = setTimeout(() => {
      this.handlePingTimeout(nodeId, sequenceNumber);
    }, this.config.pingTimeout);
    
    // Prevent timer from keeping process alive
    pingTimer.unref();

    this.pingTimers.set(nodeId, pingTimer);

    const targetNode = this.findNodeById(nodeId);
    if (targetNode) {
      this.transport.send(pingMessage, targetNode);
    }
    
    this.lastPingTimestamps.set(nodeId, Date.now());

    if (this.config.enableLogging) {
      console.log(`[FailureDetector] Sent ping to ${nodeId} (seq: ${sequenceNumber})`);
    }
  }

  /**
   * Handle ping timeout (no response received)
   */
  private handlePingTimeout(nodeId: string, sequenceNumber: number): void {
    const pending = this.pendingPings.get(nodeId);
    
    if (pending && pending.sequenceNumber === sequenceNumber) {
      this.pendingPings.delete(nodeId);
      
      const missedPings = (this.missedPings.get(nodeId) || 0) + 1;
      this.missedPings.set(nodeId, missedPings);

      if (this.config.enableLogging) {
        console.log(`[FailureDetector] Ping timeout for ${nodeId} (missed: ${missedPings}/${this.config.maxMissedPings})`);
      }

      // If too many missed pings, mark as dead
      if (missedPings >= this.config.maxMissedPings) {
        this.markNodeAsDead(nodeId, `Missed ${missedPings} consecutive pings`);
      }
    }

    this.pingTimers.delete(nodeId);
  }

  /**
   * Record that we've seen a node (e.g., received a message from it)
   */
  recordNodeActivity(nodeId: string): void {
    if (nodeId === this.localNodeId) return;
    
    const now = Date.now();
    const wasAlive = this.isNodeAlive(nodeId);
    
    this.lastSeenTimestamps.set(nodeId, now);
    this.missedHeartbeats.set(nodeId, 0);
    this.missedPings.set(nodeId, 0);

    // If the node was marked as SUSPECT or DEAD, mark it as ALIVE again
    if (!wasAlive) {
      const member = this.membership.getMember(nodeId);
      if (member && (member.status === 'SUSPECT' || member.status === 'DEAD')) {
        this.membership.updateNode({
          id: nodeId,
          status: 'ALIVE',
          lastSeen: now,
          version: member.version + 1,
          metadata: member.metadata
        });
        
        if (this.config.enableLogging) {
          console.log(`[FailureDetector] Node ${nodeId} recovered and marked as ALIVE`);
        }
        
        this.emit('node-recovered', nodeId);
      }
    }

    // Start monitoring if not already
    this.startMonitoring(nodeId);
  }

  /**
   * Check if a node is currently considered alive
   */
  private isNodeAlive(nodeId: string): boolean {
    const member = this.membership.getMember(nodeId);
    return member ? member.status === 'ALIVE' : false;
  }

  /**
   * Manually mark a node as failed (for testing or explicit failures)
   */
  markNodeFailed(nodeId: string, reason: string = 'Manual failure'): boolean {
    if (nodeId === this.localNodeId) return false;
    
    return this.markNodeAsDead(nodeId, reason);
  }

  /**
   * Mark a node as dead and emit appropriate events
   */
  private markNodeAsDead(nodeId: string, reason: string): boolean {
    const marked = this.membership.markDead(nodeId);
    
    if (marked) {
      if (this.config.enableLogging) {
        console.log(`[FailureDetector] Node ${nodeId} marked as DEAD: ${reason}`);
      }
      
      this.emit('node-failed', nodeId, reason);
      this.stopMonitoring(nodeId);
    }
    
    return marked;
  }

  /**
   * Start monitoring a specific node
   */
  private startMonitoring(nodeId: string): void {
    if (nodeId === this.localNodeId) return;
    
    this.lastSeenTimestamps.set(nodeId, Date.now());
    this.missedHeartbeats.set(nodeId, 0);
    this.missedPings.set(nodeId, 0);
    
    if (this.config.enableLogging) {
      console.log(`[FailureDetector] Started monitoring node ${nodeId}`);
    }
  }

  /**
   * Stop monitoring a specific node
   */
  private stopMonitoring(nodeId: string): void {
    // Clear timers
    const heartbeatTimer = this.heartbeatTimers.get(nodeId);
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      this.heartbeatTimers.delete(nodeId);
    }

    const pingTimer = this.pingTimers.get(nodeId);
    if (pingTimer) {
      clearTimeout(pingTimer);
      this.pingTimers.delete(nodeId);
    }
    
    // Clear state
    this.lastSeenTimestamps.delete(nodeId);
    this.lastPingTimestamps.delete(nodeId);
    this.lastPongTimestamps.delete(nodeId);
    this.missedHeartbeats.delete(nodeId);
    this.missedPings.delete(nodeId);
    this.pendingPings.delete(nodeId);
    this.sequenceNumbers.delete(nodeId);
    this.roundTripTimes.delete(nodeId);
    
    if (this.config.enableLogging) {
      console.log(`[FailureDetector] Stopped monitoring node ${nodeId}`);
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

      const missedHeartbeats = this.missedHeartbeats.get(nodeId) || 0;
      
      // Check if we should send an active ping probe
      if (this.config.enableActiveProbing && 
          member.status === 'ALIVE' && 
          timeSinceLastSeen > this.config.heartbeatInterval * 2 &&
          !this.pendingPings.has(nodeId)) {
        this.sendPing(nodeId);
      }
      
      // If node hasn't been seen for deadTimeout, mark as DEAD
      if (timeSinceLastSeen > this.config.deadTimeout && member.status !== 'DEAD') {
        this.markNodeAsDead(nodeId, `Not seen for ${timeSinceLastSeen}ms`);
      }
      // If node hasn't been seen for failureTimeout, mark as SUSPECT
      else if (timeSinceLastSeen > this.config.failureTimeout && member.status === 'ALIVE') {
        this.membership.markSuspect(nodeId, this.config.deadTimeout - this.config.failureTimeout);
        
        // Increment missed heartbeats
        this.missedHeartbeats.set(nodeId, missedHeartbeats + 1);
        
        if (this.config.enableLogging) {
          console.log(`[FailureDetector] Node ${nodeId} marked as SUSPECT (not seen for ${timeSinceLastSeen}ms, missed: ${missedHeartbeats + 1})`);
        }
        
        this.emit('node-suspected', nodeId);
        
        // Send immediate ping probe if active probing is enabled
        if (this.config.enableActiveProbing && !this.pendingPings.has(nodeId)) {
          this.sendPing(nodeId);
        }
      }
    }
  }

  /**
   * Get health status for a specific node
   */
  getNodeHealthStatus(nodeId: string): NodeHealthStatus | null {
    if (nodeId === this.localNodeId || !this.lastSeenTimestamps.has(nodeId)) {
      return null;
    }

    const member = this.membership.getMember(nodeId);
    const lastHeartbeat = this.lastSeenTimestamps.get(nodeId) || 0;
    const lastPing = this.lastPingTimestamps.get(nodeId) || 0;
    const lastPong = this.lastPongTimestamps.get(nodeId) || 0;
    const missedHeartbeats = this.missedHeartbeats.get(nodeId) || 0;
    const missedPings = this.missedPings.get(nodeId) || 0;
    const roundTripTime = this.roundTripTimes.get(nodeId);

    return {
      nodeId,
      status: member ? member.status as NodeStatus : NodeStatus.DEAD,
      lastHeartbeat,
      lastPing,
      lastPong,
      missedHeartbeats,
      missedPings,
      roundTripTime,
      isResponsive: !this.pendingPings.has(nodeId) && member?.status === 'ALIVE'
    };
  }

  /**
   * Get failure detection status
   */
  getStatus() {
    const monitoredNodes = Array.from(this.lastSeenTimestamps.keys());
    const healthStatuses = monitoredNodes.map(nodeId => this.getNodeHealthStatus(nodeId)).filter(Boolean);

    return {
      isRunning: this.isRunning,
      monitoredNodes,
      healthStatuses,
      pendingPings: Array.from(this.pendingPings.keys()),
      config: this.config,
      localSequenceNumber: this.localSequenceNumber
    };
  }
}
