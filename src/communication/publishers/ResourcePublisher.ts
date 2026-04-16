import { ResourceOperation, OpType } from '../../resources/core/ResourceOperation';
import { ConnectionManager } from '../../connections/ConnectionManager';
import { WriteAheadLog } from '../../persistence/WriteAheadLog';
import { ResourceAttachmentService } from '../../resources/attachment/ResourceAttachmentService';
import { ClusterFanoutRouter } from '../../resources/distribution/ClusterFanoutRouter';
import { Principal } from '../../resources/security/ResourceAuthorizationService';


export interface ResourcePublisher {
  publishFromClient(connId: string, resourceId: string, body: Uint8Array, meta?: any): Promise<void>;
  publishFromSystem(resourceId: string, op: ResourceOperation): Promise<void>;
}

export interface PublishContext {
  correlationId: string;
  principal?: Principal;
  skipLocalDeliver?: boolean;
  skipRemoteFanout?: boolean;
}

export class ResourcePublisherImpl implements ResourcePublisher {
  private nodeId: string;

  constructor(
    private connectionManager: ConnectionManager,
    private wal: WriteAheadLog,
    private attachmentService: ResourceAttachmentService,
    private fanoutRouter: ClusterFanoutRouter,
    nodeId: string
  ) {
    this.nodeId = nodeId;
  }

  async publishFromClient(
    connId: string, 
    resourceId: string, 
    body: Uint8Array, 
    meta: any = {}
  ): Promise<void> {
    // Get session and principal from connection
    const connection = this.connectionManager.getConnection(connId);
    if (!connection || !connection.isActive()) {
      throw new Error(`Connection ${connId} not found or inactive`);
    }

    const session = connection.session; // Use session property instead of method
    const metadata = session.getAll();
    const principal = metadata.principal as Principal | undefined;

    // Build ResourceOperation with UPDATE type (closest to PUBLISH)
    const op: ResourceOperation = {
      opId: this.generateOpId(),
      resourceId,
      type: 'UPDATE' as OpType, // Use UPDATE as closest to PUBLISH
      version: 1,
      timestamp: Date.now(),
      originNodeId: this.nodeId,
      leaseTerm: 1,
      payload: {
        body: Array.from(body), // Convert Uint8Array to serializable format
        meta,
        connId
      },
      vectorClock: this.createVectorClock(),
      correlationId: this.generateCorrelationId()
    };

    await this.processOperation(op, { 
      correlationId: op.correlationId, 
      principal 
    });
  }

  async publishFromSystem(resourceId: string, op: ResourceOperation): Promise<void> {
    // Ensure the operation has proper envelope data
    const wrappedOp = {
      ...op,
      originNodeId: op.originNodeId || this.nodeId,
      vectorClock: op.vectorClock || this.createVectorClock(),
      correlationId: op.correlationId || this.generateCorrelationId()
    };

    await this.processOperation(wrappedOp, { 
      correlationId: wrappedOp.correlationId 
    });
  }

  private async processOperation(
    op: ResourceOperation, 
    ctx: PublishContext
  ): Promise<void> {
    try {
      // Step 1: WAL append (message record)
      await this.appendToWAL(op);

      // Step 2: Local deliver (to local subscribers)
      if (!ctx.skipLocalDeliver) {
        await this.deliverLocal(op, ctx);
      }

      // Step 3: Compute routes and fan-out to remote nodes
      if (!ctx.skipRemoteFanout) {
        await this.fanoutRemote(op);
      }

      console.log(`📤 Published operation ${op.opId} for resource ${op.resourceId}`);
    } catch (error) {
      console.error(`❌ Failed to publish operation ${op.opId}:`, error);
      throw error;
    }
  }

  private async appendToWAL(op: ResourceOperation): Promise<void> {
    // Create WAL record for the message
    const walRecord = {
      opId: op.opId,
      resourceId: op.resourceId,
      body: new Uint8Array(op.payload.body || []),
      meta: {
        type: op.type,
        originNodeId: op.originNodeId,
        correlationId: op.correlationId,
        timestamp: op.timestamp.toString(),
        ...op.payload.meta
      },
      vectorClock: op.vectorClock
    };

    await this.wal.append(walRecord);
  }

  private async deliverLocal(
    op: ResourceOperation, 
    ctx: PublishContext
  ): Promise<void> {
    // Use the correct signature for deliverLocal
    const stats = await this.attachmentService.deliverLocal(
      op.resourceId, 
      op, 
      ctx.correlationId
    );

    console.log(`📍 Local delivery stats for ${op.opId}: ${JSON.stringify(stats)}`);
  }

  private async fanoutRemote(op: ResourceOperation): Promise<void> {
    // Compute target nodes using placement-aware routing
    const routingStrategy = {
      preferPrimary: true,
      replicationFactor: 2,
      useGossipFallback: true
    };
    const routes = await this.fanoutRouter.route(op.resourceId, routingStrategy);
    
    if (routes.length > 0) {
      await this.fanoutRouter.fanoutRemote(routes, op);
      console.log(`🌐 Fanout operation ${op.opId} to ${routes.length} remote nodes`);
    }
  }

  private createVectorClock(): any {
    // Create a simple vector clock implementation
    return {
      nodeId: this.nodeId,
      vector: new Map([[this.nodeId, 1]]),
      increment: function() { return this; },
      compare: function() { return 0; },
      merge: function() { return this; }
    };
  }

  private generateOpId(): string {
    // Generate UUID v7 (timestamp-based) for better ordering
    return `${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateCorrelationId(): string {
    return `corr-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 6)}`;
  }
}
