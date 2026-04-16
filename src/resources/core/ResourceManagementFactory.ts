import { ClusterManager } from '../../cluster/ClusterManager';
import { ConnectionManager } from '../../connections/ConnectionManager';
import { ResourceRegistry, ResourceRegistryConfig } from './ResourceRegistry';
import { ResourceAttachmentService } from '../attachment/ResourceAttachmentService';
import { ResourceDistributionEngine } from '../distribution/ResourceDistributionEngine';
import { ClusterFanoutRouter } from '../distribution/ClusterFanoutRouter';
import { ResourceAuthorizationService } from '../security/ResourceAuthorizationService';
import { OperationDeduplicator } from '../../communication/deduplication/OperationDeduplicator';
import { CausalOrderingEngine } from '../../communication/ordering/CausalOrderingEngine';
import { WriteAheadLog } from '../../persistence/WriteAheadLog';
import { BoundedQueue, OutboundQueue, BackpressureConfig } from '../../connections/ConnectionBackpressure';
import { 
  IntegratedCommunicationLayer, 
  IntegratedLayerResult,
  FlowControlManager 
} from '../../communication/core/IntegratedCommunicationLayer';
import { 
  ClusterSender, 
  ClusterReceiver, 
  TransportServer, 
  TimeProvider,
  OperationEnvelopeManager,
  ResourcePublisher,
  ResourceSubscriber
} from '../../communication/core/ports';
import { SemanticsConfig, SemanticsConfigValidator, DEFAULT_SEMANTICS_CONFIG } from '../../communication/semantics/SemanticsConfig';
import { ResourceOperation, OpType } from './ResourceOperation';
import { MessageCodec, defaultCodec } from '../../communication/core/MessageCodec';
import { ObservabilityManager } from '../../observability/ObservabilityManager';
import { Logger } from '../../common/logger';


/**
 * Phase E: Config validation with hard-fail for invalid semantics
 */
function validateSemanticsConfig(config: SemanticsConfig): void {
  // Validate dedup settings
  if (config.dedupTtlMs <= 0) {
    throw new Error('dedupTtlMs must be positive');
  }
  
  // Validate causal ordering settings
  if (config.causal.maxBufferPerResource <= 0) {
    throw new Error('causal.maxBufferPerResource must be positive');
  }
  if (config.causal.maxWaitMs <= 0) {
    throw new Error('causal.maxWaitMs must be positive');
  }
  if (!['drop-oldest', 'drop-newest', 'block'].includes(config.causal.overflow)) {
    throw new Error('causal.overflow must be drop-oldest, drop-newest, or block');
  }
  
  // Validate WAL settings
  if (config.wal.snapshotEveryOps <= 0) {
    throw new Error('wal.snapshotEveryOps must be positive');
  }
  if (config.wal.maxReplayMs <= 0) {
    throw new Error('wal.maxReplayMs must be positive');
  }
  
  // Validate flow control settings
  if (config.flow.maxQueuePerConn <= 0) {
    throw new Error('flow.maxQueuePerConn must be positive');
  }
  if (config.flow.writeTimeoutMs <= 0) {
    throw new Error('flow.writeTimeoutMs must be positive');
  }
  if (!['oldest', 'newest', 'error'].includes(config.flow.dropPolicy)) {
    throw new Error('flow.dropPolicy must be oldest, newest, or error');
  }
  
  // Validate routing settings
  if (config.routing.replicationFactor < 1) {
    throw new Error('routing.replicationFactor must be at least 1');
  }
}

const factoryLogger = Logger.create('ResourceManagementFactory');

/**
 * Phase F: Operation trace for debugging
 */
function traceOperation(opId: string, resourceId: string, phase: string, nodeId?: string): void {
  const timestamp = Date.now();
  factoryLogger.debug(`[TRACE] ${timestamp} | ${opId} | ${resourceId} | ${phase} | ${nodeId || 'local'}`);
}

/**
 * Default time provider implementation
 */
class DefaultTimeProvider implements TimeProvider {
  nowMs(): number {
    return Date.now();
  }
}

/**
 * Real envelope manager with proper IDs and vector clocks
 */
class OperationEnvelopeManagerImpl implements OperationEnvelopeManager {
  private localVector: number = 0;
  
  constructor(
    private nodeId: string,
    private timeProvider: TimeProvider
  ) {}

  wrap<T>(type: OpType, resourceId: string, payload: T, opts?: any): ResourceOperation<T> {
    // Increment local vector clock
    this.localVector++;
    
    // Create proper vector clock
    const vectorClock = {
      nodeId: this.nodeId,
      vector: new Map([[this.nodeId, this.localVector]]),
      increment: function() { 
        const current = this.vector.get(this.nodeId) || 0;
        this.vector.set(this.nodeId, current + 1);
        return this; 
      },
      compare: function(other: any) { 
        // Fix #7: Compare across all nodes, not just local
        let lt = false, gt = false;
        for (const [id, t] of this.vector) {
          const o = other.vector.get(id) || 0;
          if (t < o) lt = true;
          if (t > o) gt = true;
        }
        for (const [id, o] of other.vector) {
          if (!this.vector.has(id) && o > 0) lt = true;
        }
        if (lt && !gt) return -1; // this happens-before other
        if (gt && !lt) return 1;  // this happens-after other
        return 0; // concurrent
      },
      merge: function(other: any) { 
        for (const [nodeId, time] of other.vector) {
          const currentTime = this.vector.get(nodeId) || 0;
          this.vector.set(nodeId, Math.max(currentTime, time));
        }
        return this; 
      }
    };

    // Generate UUID v7-like opId (timestamp-based)
    const timestamp = this.timeProvider.nowMs();
    const randomPart = Math.random().toString(36).substring(2, 10);
    const opId = `${timestamp.toString(36)}-${randomPart}-${this.nodeId.substring(0, 4)}`;

    return {
      opId,
      resourceId,
      type,
      version: 1,
      timestamp,
      originNodeId: this.nodeId,
      payload,
      vectorClock,
      correlationId: opts?.correlationId || `${type.toLowerCase()}-${timestamp}`,
      leaseTerm: opts?.leaseTerm || 1,
      metadata: opts?.metadata || {}
    };
  }

  /**
   * Advance vector clock when receiving operations from other nodes
   */
  advance(otherVector: Map<string, number>): void {
    for (const [nodeId, time] of otherVector) {
      if (nodeId !== this.nodeId) {
        const currentTime = this.localVector;
        // Update our vector based on other node's time
        this.localVector = Math.max(currentTime, time);
      }
    }
  }
}

/**
 * Flow control manager implementation with proper outbound queues
 */
class FlowControlManagerImpl implements FlowControlManager {
  private queues = new Map<string, OutboundQueue>();
  private config: BackpressureConfig;
  
  constructor(flowConfig: { maxQueuePerConn: number; writeTimeoutMs: number; dropPolicy: string }) {
    this.config = {
      maxQueuePerConnection: flowConfig.maxQueuePerConn,
      writeTimeoutMs: flowConfig.writeTimeoutMs,
      dropPolicy: flowConfig.dropPolicy as 'oldest' | 'newest' | 'error',
      slowConsumerThresholdMs: 30000,
      maxRetries: 3
    };
  }

  canAccept(connectionId: string): boolean {
    const queue = this.getOrCreateQueue(connectionId);
    return !queue.isFull();
  }

  recordWrite(connectionId: string, bytes: number): void {
    // Legacy method for compatibility - not used with queue-based flow control
    factoryLogger.debug(`Legacy recordWrite called for ${connectionId}: ${bytes} bytes`);
  }

  recordDrop(connectionId: string, reason: string): void {
    factoryLogger.warn(`Flow control drop for ${connectionId}: ${reason}`);
  }

  enqueue(connectionId: string, data: any, meta: { opId?: string; priority?: number } = {}): 'enqueued' | 'dropped' | 'error' {
    const queue = this.getOrCreateQueue(connectionId);
    return queue.offer(data, meta);
  }

  async deliver(connectionId: string, writer: (data: any) => Promise<void>): Promise<void> {
    const queue = this.getOrCreateQueue(connectionId);
    await queue.drain(writer);
  }

  private getOrCreateQueue(connectionId: string): OutboundQueue {
    let queue = this.queues.get(connectionId);
    if (!queue) {
      queue = new BoundedQueue(this.config, connectionId);
      this.queues.set(connectionId, queue);
    }
    return queue;
  }

  clearQueue(connectionId: string): void {
    const queue = this.queues.get(connectionId);
    if (queue) {
      queue.clear();
      this.queues.delete(connectionId);
    }
  }
}

/**
 * Publisher implementation that enforces WAL-before-send semantics with observability
 */
class ResourcePublisherImpl implements ResourcePublisher {
  constructor(
    private envelope: OperationEnvelopeManager,
    private wal: WriteAheadLog,
    private router: ClusterFanoutRouter,
    private distribution: ResourceDistributionEngine,
    private attachment: ResourceAttachmentService,
    private authz: ResourceAuthorizationService,
    private flow: FlowControlManager,
    private observability: ObservabilityManager,
    private nodeId: string
  ) {}

  async publishFromClient(connId: string, resourceId: string, body: Uint8Array, meta?: any): Promise<void> {
    const startTime = Date.now();
    let operation: ResourceOperation | undefined;

    try {
      // Flow control check
      if (!this.flow.canAccept(connId)) {
        throw new Error(`Flow control: connection ${connId} queue full`);
      }

      // Create operation from client data
      operation = this.envelope.wrap('UPDATE', resourceId, { 
        kind: 'message',
      body: Array.from(body), // Convert Uint8Array to regular array for serialization
      meta,
      connId
    });

    // WAL-before-send semantics - critical invariant
    const messageRecord: MessageRecord = {
      kind: 'message',
      op: operation,
      ts: Date.now()
    };
    await this.wal.append(messageRecord);

    // Local delivery first
    await this.attachment.deliverLocal(resourceId, operation, operation.correlationId);

    // Route and distribute to cluster
    const routes = await this.router.route(resourceId, { 
      preferPrimary: true, 
      replicationFactor: 2, 
      useGossipFallback: true 
    });
    if (routes.length > 0) {
      await this.distribution.sendRemote(operation, routes);
    }

    // Record successful operation
    this.observability.trace({
      opId: operation.opId,
      resourceId,
      phase: 'deliver',
      nodeId: this.nodeId,
      duration: Date.now() - startTime
    });

    } catch (error) {
      // Record error in observability  
      this.observability.trace({
        opId: operation?.opId || 'unknown',
        resourceId,
        phase: 'deliver',
        nodeId: this.nodeId,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async publishFromSystem(resourceId: string, op: ResourceOperation): Promise<void> {
    // WAL-before-send
    const systemRecord: MessageRecord = {
      kind: 'message',
      op,
      ts: Date.now()
    };
    await this.wal.append(systemRecord);

    // Local delivery
    await this.attachment.deliverLocal(resourceId, op, op.correlationId);

    // Route and distribute to cluster using pure router + distribution engine
    const routes = await this.router.route(resourceId, { 
      preferPrimary: true, 
      replicationFactor: 2, 
      useGossipFallback: true 
    });
    if (routes.length > 0) {
      await this.distribution.sendRemote(op, routes);
    }
  }
}

/**
 * Subscriber implementation for resource subscriptions with proper JOIN/LEAVE ops
 */
class ResourceSubscriberImpl implements ResourceSubscriber {
  constructor(
    private attachment: ResourceAttachmentService,
    private authz: ResourceAuthorizationService,
    private envelope: OperationEnvelopeManager,
    private wal: WriteAheadLog,
    private router: ClusterFanoutRouter,
    private distribution: ResourceDistributionEngine
  ) {}

  async join(connId: string, resourceId: string, filters?: any): Promise<void> {
    // Create JOIN operation
    const joinOp = this.envelope.wrap('JOIN', resourceId, { 
      connId, 
      filters,
      action: 'join'
    });

    // WAL-before-send for JOIN operations
    const membershipRecord: MembershipRecord = {
      kind: 'membership',
      op: joinOp,
      ts: Date.now()
    };
    await this.wal.append(membershipRecord);

    // Local attachment
    await this.attachment.attach(connId, resourceId, filters);

    // Route to cluster
    const routes = await this.router.route(resourceId, { 
      preferPrimary: true, 
      replicationFactor: 2, 
      useGossipFallback: true 
    });
    if (routes.length > 0) {
      await this.distribution.sendRemote(joinOp, routes);
    }
  }

  async leave(connId: string, resourceId: string): Promise<void> {
    // Create LEAVE operation
    const leaveOp = this.envelope.wrap('LEAVE', resourceId, { 
      connId,
      action: 'leave'
    });

    // WAL-before-send for LEAVE operations
    const membershipRecord: MembershipRecord = {
      kind: 'membership',
      op: leaveOp,
      ts: Date.now()
    };
    await this.wal.append(membershipRecord);

    // Local detachment
    await this.attachment.detach(connId, resourceId);

    // Route to cluster
    const routes = await this.router.route(resourceId, { 
      preferPrimary: true, 
      replicationFactor: 2, 
      useGossipFallback: true 
    });
    if (routes.length > 0) {
      await this.distribution.sendRemote(leaveOp, routes);
    }
  }
}

/**
 * WAL Record Types for proper taxonomy
 */
export interface MessageRecord {
  kind: 'message';
  op: ResourceOperation;
  ts: number;
}

export interface MembershipRecord {
  kind: 'membership';
  op: ResourceOperation;
  ts: number;
}

export type WALRecord = MessageRecord | MembershipRecord;

/**
 * WAL implementation with proper record taxonomy and readSince API
 */
class SimpleWriteAheadLog extends WriteAheadLog {
  private entries: WALRecord[] = [];

  async append(entry: any): Promise<void> {
    // Convert legacy entries to proper WAL records
    let walRecord: WALRecord;
    if (entry.kind && entry.op) {
      walRecord = entry as WALRecord;
    } else {
      // Legacy format - assume it's a message record
      walRecord = {
        kind: 'message',
        op: entry.operation || entry,
        ts: Date.now()
      };
    }
    
    this.entries.push(walRecord);
    (this as any).log.push(walRecord);
    factoryLogger.debug(`WAL append: ${walRecord.kind} ${walRecord.op.opId || 'unknown'}`);
  }

  async read(from: number, to: number): Promise<WALRecord[]> {
    return this.entries.slice(from, to);
  }

  readAll(): WALRecord[] {
    return [...this.entries];
  }

  async readSince(offset: number, limit: number): Promise<WALRecord[]> {
    return this.entries.slice(offset, offset + limit);
  }

  async compact(): Promise<void> {
    if (this.entries.length > 1000) {
      this.entries = this.entries.slice(-1000);
    }
  }

  async clear(): Promise<void> {
    this.entries = [];
    (this as any).log = [];
  }

  async getLastIndex(): Promise<number> { 
    return this.entries.length; 
  }
}

/**
 * Enhanced attachment service with members() for Example v2 assertions
 */
class AttachmentServiceWrapper {
  constructor(private baseService: ResourceAttachmentService) {}

  async attach(connId: string, resourceId: string, filters?: any): Promise<void> {
    return this.baseService.attach(connId, resourceId, filters);
  }

  async detach(connId: string, resourceId: string): Promise<void> {
    return this.baseService.detach(connId, resourceId);
  }

  async deliverLocal(resourceId: string, operation: ResourceOperation, correlationId?: string): Promise<void> {
    await this.baseService.deliverLocal(resourceId, operation, correlationId || 'default');
  }

  async members(resourceId: string): Promise<Set<string>> {
    // Return local members for this resource
    const attachments = (this.baseService as any).attachments || new Map();
    return attachments.get(resourceId) || new Set();
  }
}

/**
 * SOLID-compliant Resource Management Factory
 * 
 * Implements composition root pattern with proper dependency inversion.
 * All dependencies are injected through ports/interfaces.
 */
export class ResourceManagementFactory {
  /**
   * Create integrated communication layer with SOLID principles
   * Supports Example v2 requirements: publisher/subscriber/attachment/WAL with assertions
   */
  static createIntegratedCommunicationLayer(args: {
    clusterManager: ClusterManager;
    clientAdapter: TransportServer & { connectionManager: ConnectionManager };
    semantics?: SemanticsConfig;
    time?: TimeProvider;
    codec?: MessageCodec;
  }): IntegratedLayerResult {
    
    const semantics = args.semantics || DEFAULT_SEMANTICS_CONFIG;
    
    // Phase E: Config validation with hard-fail for invalid semantics
    factoryLogger.info('Validating semantics configuration...');
    try {
      validateSemanticsConfig(semantics);
      factoryLogger.info('Semantics configuration valid');
    } catch (error: any) {
      factoryLogger.error('Invalid semantics configuration:', error);
      throw new Error(`Configuration validation failed: ${error.message}`);
    }
    const time = args.time || new DefaultTimeProvider();
    const codec = args.codec || defaultCodec;

    // Validate configuration
    const validation = SemanticsConfigValidator.validate(semantics);
    if (validation.errors.length > 0) {
      throw new Error(`Invalid semantics config: ${validation.errors.join(', ')}`);
    }

    // Ports - adapt existing ClusterManager to our interfaces
    const clusterMgr = args.clusterManager;
    const sender: ClusterSender = {
      async sendTo(nodeId: string, bytes: Uint8Array): Promise<void> {
        // Keep bytes end-to-end - tunnel over existing JSON channel using base64
        const b64 = Buffer.from(bytes).toString('base64');
        await clusterMgr.sendCustomMessage('resource:bytes', { b64 }, [nodeId]);
      }
    };
    
    const receiver: ClusterReceiver = {
      onMessage(handler: (from: string, bytes: Uint8Array) => void): void {
        // Listen for raw bytes messages and decode base64 once
        (args.clusterManager as any).on('custom-message', (data: any) => {
          if (data.message && data.message.type === 'resource:bytes' && data.message.b64) {
            const bytes = new Uint8Array(Buffer.from(data.message.b64, 'base64'));
            handler(data.senderId, bytes);
          }
        });
      }
    };

    // Core services with observability
    const observability = new ObservabilityManager();
    const envelope: OperationEnvelopeManager = new OperationEnvelopeManagerImpl(
      args.clusterManager.localNodeId, 
      time
    );
    
    const wal: WriteAheadLog = new SimpleWriteAheadLog();
    const dedup: OperationDeduplicator = new OperationDeduplicator();
    const causal: CausalOrderingEngine = new CausalOrderingEngine(args.clusterManager.localNodeId);
    const authz: ResourceAuthorizationService = new ResourceAuthorizationService();
    const flow: FlowControlManager = new FlowControlManagerImpl(semantics.flow);

    // Registry
    const registryConfig: ResourceRegistryConfig = {
      nodeId: args.clusterManager.localNodeId,
      entityRegistryType: 'memory' as const,
      clusterManager: args.clusterManager
    };
    const registry = new ResourceRegistry(registryConfig);

    // Resource services - no wrapper needed, ResourceAttachmentService has members()
    const baseAttachment = new ResourceAttachmentService(args.clientAdapter.connectionManager);
    
    const router = new ClusterFanoutRouter(
      args.clusterManager,
      {
        preferPrimary: semantics.routing.preferPrimary,
        replicationFactor: semantics.routing.replicationFactor,
        useGossipFallback: true
      }
    );
    
    const distribution = new ResourceDistributionEngine(
      registry,
      args.clusterManager,
      undefined, // stateReconciler
      undefined, // semanticsConfig
      {
        operationDeduplicator: dedup,
        causalOrderingEngine: causal,
        attachmentService: baseAttachment
      }
    );

    // Façades with observability
    const publisher = new ResourcePublisherImpl(
      envelope, wal, router, distribution, baseAttachment, authz, flow, observability, args.clusterManager.localNodeId
    );
    
    const subscriber = new ResourceSubscriberImpl(
      baseAttachment, authz, envelope, wal, router, distribution
    );

    // Lifecycle management with proper ordering and safety rails
    let isStarted = false;
    let isStopping = false;

    const start = async (): Promise<void> => {
      if (isStarted) {
        factoryLogger.warn('IntegratedCommunicationLayer already started');
        return;
      }
      if (isStopping) {
        throw new Error('Cannot start while stopping');
      }

      // Phase E: Config validation with hard-fail for invalid semantics
      const validation = SemanticsConfigValidator.validate(semantics);
      if (validation.errors.length > 0) {
        const errorMsg = `Invalid semantics config: ${validation.errors.join(', ')}`;
        factoryLogger.error(errorMsg);
        throw new Error(errorMsg);
      }
      if (validation.warnings.length > 0) {
        factoryLogger.warn('Semantics config warnings: ' + validation.warnings.join(', '));
      }

      factoryLogger.info('Starting IntegratedCommunicationLayer...');
      
      try {
        // Step 1: Register receiver BEFORE starting cluster (fix #6)
        factoryLogger.info('Registering cluster message receiver...');
        receiver.onMessage((from: string, bytes: Uint8Array) => {
          try {
            const operation = codec.decode(bytes);
            distribution.receiveRemote(operation);
          } catch (error) {
            factoryLogger.error('Failed to process cluster message:', error);
          }
        });
        
        // Step 2: Start cluster transport
        factoryLogger.info('Starting cluster manager...');
        await args.clusterManager.start();
        
        // Step 3: Start client transport  
        factoryLogger.info('Starting client adapter...');
        await args.clientAdapter.start();

        isStarted = true;
        factoryLogger.info('IntegratedCommunicationLayer started successfully');
        
      } catch (error) {
        factoryLogger.error('Failed to start IntegratedCommunicationLayer:', error);
        // Attempt cleanup on partial start failure
        try {
          await stop();
        } catch (stopError) {
          factoryLogger.error('Failed to cleanup after start failure:', stopError);
        }
        throw error;
      }
    };

    const stop = async (): Promise<void> => {
      if (!isStarted) {
        factoryLogger.warn('IntegratedCommunicationLayer not started');
        return;
      }
      if (isStopping) {
        factoryLogger.warn('IntegratedCommunicationLayer already stopping');
        return;
      }

      factoryLogger.info('Stopping IntegratedCommunicationLayer...');
      isStopping = true;
      
      try {
        // Reverse order of start: client first, then cluster
        factoryLogger.info('Stopping client adapter...');
        await args.clientAdapter.stop();
        
        factoryLogger.info('Stopping cluster manager...');
        await args.clusterManager.stop();

        isStarted = false;
        factoryLogger.info('IntegratedCommunicationLayer stopped successfully');
        
      } catch (error) {
        factoryLogger.error('Failed to stop IntegratedCommunicationLayer:', error);
        throw error;
      } finally {
        isStopping = false;
      }
    };

    const layer: IntegratedCommunicationLayer = {
      publisher,
      subscriber,
      attachment: baseAttachment as any, // Real service with members()
      distribution,
      router,
      authz,
      wal: wal as any, // Add readSince method
      flow,
      dedup,
      causal,
      start,
      stop
    };

    return {
      layer,
      warnings: validation.warnings,
      config: {
        nodeId: args.clusterManager.localNodeId,
        semantics,
        enableWAL: true,
        enableAuth: semantics.auth.enforceAt.length > 0,
        enableFlowControl: true
      }
    };
  }
}
