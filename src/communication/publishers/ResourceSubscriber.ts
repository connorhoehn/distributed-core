import { ResourceOperation, OpType } from '../../resources/core/ResourceOperation';
import { ConnectionManager } from '../../connections/ConnectionManager';
import { WriteAheadLog } from '../../persistence/WriteAheadLog';
import { ResourceAttachmentService } from '../../resources/attachment/ResourceAttachmentService';
import { ClusterFanoutRouter } from '../../resources/distribution/ClusterFanoutRouter';
import { DeliveryGuard } from '../../communication/delivery/DeliveryGuard';
import { Principal } from '../../resources/security/ResourceAuthorizationService';

// Node.js environment access
declare const console: any;

export interface ResourceSubscriber {
  join(connId: string, resourceId: string, filters?: any): Promise<void>;
  leave(connId: string, resourceId: string): Promise<void>;
}

export interface SubscriptionContext {
  correlationId: string;
  principal?: Principal;
  skipAuth?: boolean;
  skipRemoteFanout?: boolean;
}

export class ResourceSubscriberImpl implements ResourceSubscriber {
  private nodeId: string;

  constructor(
    private connectionManager: ConnectionManager,
    private wal: WriteAheadLog,
    private attachmentService: ResourceAttachmentService,
    private fanoutRouter: ClusterFanoutRouter,
    private deliveryGuard: DeliveryGuard,
    nodeId: string
  ) {
    this.nodeId = nodeId;
  }

  async join(connId: string, resourceId: string, filters: any = {}): Promise<void> {
    // Get session and principal from connection
    const connection = this.connectionManager.getConnection(connId);
    if (!connection || !connection.isActive()) {
      throw new Error(`Connection ${connId} not found or inactive`);
    }

    const session = connection.session;
    const metadata = session.getAll();
    const principal = metadata.principal as Principal | undefined;

    const correlationId = this.generateCorrelationId();

    // Step 1: Authorization check
    const canJoin = await this.checkJoinAuthorization(principal, resourceId);
    if (!canJoin) {
      throw new Error(`Connection ${connId} not authorized to join resource ${resourceId}`);
    }

    // Step 2: Build JOIN operation
    const joinOp: ResourceOperation = {
      opId: this.generateOpId(),
      resourceId,
      type: 'CREATE' as OpType, // Use CREATE for JOIN semantics
      version: 1,
      timestamp: Date.now(),
      originNodeId: this.nodeId,
      leaseTerm: 1,
      payload: {
        action: 'join',
        connId,
        filters,
        principal: principal ? { id: principal.id, type: principal.type, attributes: principal.attributes } : undefined
      },
      vectorClock: this.createVectorClock(),
      correlationId
    };

    await this.processJoinOperation(joinOp, {
      correlationId,
      principal
    });
  }

  async leave(connId: string, resourceId: string): Promise<void> {
    // Get session for context
    const connection = this.connectionManager.getConnection(connId);
    if (!connection) {
      // Connection might already be gone, but we should still clean up
      console.log(`⚠️ Connection ${connId} not found during leave, proceeding with cleanup`);
    }

    const correlationId = this.generateCorrelationId();

    // Step 1: Build LEAVE operation
    const leaveOp: ResourceOperation = {
      opId: this.generateOpId(),
      resourceId,
      type: 'DELETE' as OpType, // Use DELETE for LEAVE semantics
      version: 1,
      timestamp: Date.now(),
      originNodeId: this.nodeId,
      leaseTerm: 1,
      payload: {
        action: 'leave',
        connId
      },
      vectorClock: this.createVectorClock(),
      correlationId
    };

    await this.processLeaveOperation(leaveOp, {
      correlationId
    });
  }

  private async checkJoinAuthorization(
    principal: Principal | undefined, 
    resourceId: string
  ): Promise<boolean> {
    // If no principal, deny access (could be made configurable)
    if (!principal) {
      return false;
    }

    // Create a dummy operation for authorization check
    const authOp: ResourceOperation = {
      opId: 'auth-check',
      resourceId,
      type: 'CREATE',
      version: 1,
      timestamp: Date.now(),
      originNodeId: this.nodeId,
      leaseTerm: 1,
      payload: { action: 'join' },
      vectorClock: this.createVectorClock(),
      correlationId: 'auth-check'
    };

    return await this.deliveryGuard.canDeliver(principal, resourceId, authOp);
  }

  private async processJoinOperation(
    op: ResourceOperation,
    ctx: SubscriptionContext
  ): Promise<void> {
    try {
      // Step 1: WAL append (optional for durable subscriptions)
      await this.appendToWAL(op);

      // Step 2: Local attach (immediate membership)
      await this.attachLocal(op, ctx);

      // Step 3: Fan-out JOIN to remote nodes (so they know about this subscription)
      if (!ctx.skipRemoteFanout) {
        await this.fanoutRemote(op);
      }

      console.log(`✅ Join operation ${op.opId} completed for resource ${op.resourceId}`);
    } catch (error) {
      console.error(`❌ Failed to process join operation ${op.opId}:`, error);
      throw error;
    }
  }

  private async processLeaveOperation(
    op: ResourceOperation,
    ctx: SubscriptionContext
  ): Promise<void> {
    try {
      // Step 1: WAL append (optional)
      await this.appendToWAL(op);

      // Step 2: Local detach (immediate removal)
      await this.detachLocal(op, ctx);

      // Step 3: Fan-out LEAVE to remote nodes
      if (!ctx.skipRemoteFanout) {
        await this.fanoutRemote(op);
      }

      console.log(`✅ Leave operation ${op.opId} completed for resource ${op.resourceId}`);
    } catch (error) {
      console.error(`❌ Failed to process leave operation ${op.opId}:`, error);
      throw error;
    }
  }

  private async appendToWAL(op: ResourceOperation): Promise<void> {
    // Create WAL record for the subscription event
    const walRecord = {
      opId: op.opId,
      resourceId: op.resourceId,
      body: new Uint8Array([]), // Empty body for subscription ops
      meta: {
        type: op.type,
        action: op.payload.action,
        originNodeId: op.originNodeId,
        correlationId: op.correlationId,
        timestamp: op.timestamp.toString(),
        connId: op.payload.connId
      },
      vectorClock: op.vectorClock
    };

    await this.wal.append(walRecord);
  }

  private async attachLocal(
    op: ResourceOperation,
    ctx: SubscriptionContext
  ): Promise<void> {
    const connId = op.payload.connId;
    const filters = op.payload.filters;

    // Use ResourceAttachmentService to manage local membership
    await this.attachmentService.attach(connId, op.resourceId, filters);
    
    console.log(`📍 Attached connection ${connId} to resource ${op.resourceId}`);
  }

  private async detachLocal(
    op: ResourceOperation,
    ctx: SubscriptionContext
  ): Promise<void> {
    const connId = op.payload.connId;

    // Use ResourceAttachmentService to remove local membership
    await this.attachmentService.detach(connId, op.resourceId);
    
    console.log(`📍 Detached connection ${connId} from resource ${op.resourceId}`);
  }

  private async fanoutRemote(op: ResourceOperation): Promise<void> {
    // Compute target nodes using placement-aware routing
    const routes = await this.fanoutRouter.route(op.resourceId, {
      preferPrimary: true,
      replicationFactor: 2,
      useGossipFallback: true
    });
    
    if (routes.length > 0) {
      // You need to send the operation to each node in routes
      for (const route of routes) {
        // Send the operation to each node in the route
        await this.fanoutRouter.sendToNode(route.nodeId, op);
      }
      console.log(`🌐 Fanout subscription operation ${op.opId} to ${routes.length} remote nodes`);
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
    return `sub-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 6)}`;
  }
}
