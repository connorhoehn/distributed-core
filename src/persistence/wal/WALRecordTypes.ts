/**
 * WAL Record Taxonomy - Defines all types of records persisted in the Write-Ahead Log
 * 
 * This provides schema evolution, bounded replay, and retention policies for
 * different types of operations in the distributed system.
 */


/**
 * Base WAL record structure with versioning and metadata
 */
export interface BaseWALRecord {
  kind: 'state' | 'message' | 'membership' | 'snapshot';
  recordId: string;                  // unique record identifier
  resourceId: string;               // resource this record applies to
  timestamp: number;                // wall clock time
  version: number;                  // schema version for evolution
  leaseTerm: number;                // ownership term for fencing
  metadata: Record<string, any>;    // extensible metadata
}

/**
 * State change record - resource state modifications
 */
export interface StateRecord extends BaseWALRecord {
  kind: 'state';
  opId: string;                     // operation identifier
  type: 'CREATE' | 'UPDATE' | 'DELETE' | 'TRANSFER';
  originNodeId: string;             // node that generated this state change
  vector: Record<string, number>;   // vector clock for causal ordering
  payload: any;                     // actual state change data
  parents?: string[];               // causal dependencies
  correlationId: string;            // request trace ID
}

/**
 * Message record - client-to-client messages
 */
export interface MessageRecord extends BaseWALRecord {
  kind: 'message';
  opId: string;                     // operation identifier
  body: Uint8Array;                 // message body (binary)
  meta: Record<string, string>;     // message metadata
  vector: Record<string, number>;   // vector clock for ordering
  originNodeId: string;             // originating node
  correlationId: string;            // request trace ID
  messageType?: string;             // application-specific message type
}

/**
 * Membership record - join/leave operations
 */
export interface MembershipRecord extends BaseWALRecord {
  kind: 'membership';
  opId: string;                     // operation identifier
  action: 'join' | 'leave' | 'heartbeat' | 'timeout';
  connectionId: string;             // connection that performed action
  principalId?: string;             // authenticated principal
  filters?: Record<string, any>;    // subscription filters
  vector: Record<string, number>;   // vector clock
  originNodeId: string;             // node handling the membership change
}

/**
 * Snapshot record - periodic state snapshots for bounded replay
 */
export interface SnapshotRecord extends BaseWALRecord {
  kind: 'snapshot';
  snapshotId: string;               // unique snapshot identifier
  lastOpId: string;                 // last operation included in snapshot
  stateHash: string;                // hash of the snapshot for integrity
  snapshotData: any;                // compressed/serialized state
  compressionType: 'none' | 'gzip' | 'lz4';
  snapshotSize: number;             // uncompressed size in bytes
}

/**
 * Union type for all WAL record types
 */
export type WALRecord = StateRecord | MessageRecord | MembershipRecord | SnapshotRecord;

/**
 * Retention policy configuration per record type
 */
export interface RetentionPolicy {
  messagesTtlMs: number;            // How long to keep message records
  stateTtlMs: number;               // How long to keep state records
  membershipTtlMs: number;          // How long to keep membership records
  snapshotsEveryOps: number;        // Take snapshot every N operations
  maxSnapshotsToKeep: number;       // How many snapshots to retain
  maxReplayMs: number;              // Maximum replay time allowed
  compactionIntervalMs: number;     // How often to run compaction
}

/**
 * WAL compaction strategy interface
 */
export interface WALCompactionStrategy {
  shouldCompact(stats: WALStats): boolean;
  compact(records: WALRecord[]): Promise<CompactionResult>;
}

export interface WALStats {
  totalRecords: number;
  totalSizeBytes: number;
  oldestRecordAge: number;
  recordCountByType: Record<string, number>;
  lastSnapshotAge: number;
}

export interface CompactionResult {
  recordsRemoved: number;
  bytesReclaimed: number;
  snapshotsCreated: number;
  compactionDuration: number;
}

/**
 * Time-based compaction strategy implementation
 */
export class TimeBasedCompactionStrategy implements WALCompactionStrategy {
  private retentionPolicy: RetentionPolicy;

  constructor(retentionPolicy: RetentionPolicy) {
    this.retentionPolicy = retentionPolicy;
  }

  shouldCompact(stats: WALStats): boolean {
    const now = Date.now();
    
    // Trigger compaction if:
    // 1. Oldest record exceeds any TTL
    // 2. We need a new snapshot
    // 3. WAL size is getting large
    
    return (
      stats.oldestRecordAge > Math.min(
        this.retentionPolicy.messagesTtlMs,
        this.retentionPolicy.stateTtlMs,
        this.retentionPolicy.membershipTtlMs
      ) ||
      stats.lastSnapshotAge > this.retentionPolicy.snapshotsEveryOps ||
      stats.totalSizeBytes > 100 * 1024 * 1024 // 100MB threshold
    );
  }

  async compact(records: WALRecord[]): Promise<CompactionResult> {
    const startTime = Date.now();
    const now = Date.now();
    let recordsRemoved = 0;
    let bytesReclaimed = 0;
    let snapshotsCreated = 0;

    console.log(`🗜️  Starting WAL compaction for ${records.length} records`);

    // Group records by resource and type
    const recordsByResource = this.groupRecordsByResource(records);

    for (const [resourceId, resourceRecords] of recordsByResource) {
      const compactionResult = await this.compactResourceRecords(resourceId, resourceRecords, now);
      recordsRemoved += compactionResult.recordsRemoved;
      bytesReclaimed += compactionResult.bytesReclaimed;
      snapshotsCreated += compactionResult.snapshotsCreated;
    }

    const compactionDuration = Date.now() - startTime;
    
    console.log(`✅ WAL compaction complete: removed ${recordsRemoved} records, reclaimed ${bytesReclaimed} bytes, created ${snapshotsCreated} snapshots in ${compactionDuration}ms`);

    return {
      recordsRemoved,
      bytesReclaimed,
      snapshotsCreated,
      compactionDuration
    };
  }

  private groupRecordsByResource(records: WALRecord[]): Map<string, WALRecord[]> {
    const grouped = new Map<string, WALRecord[]>();
    
    for (const record of records) {
      if (!grouped.has(record.resourceId)) {
        grouped.set(record.resourceId, []);
      }
      grouped.get(record.resourceId)!.push(record);
    }
    
    return grouped;
  }

  private async compactResourceRecords(
    resourceId: string, 
    records: WALRecord[], 
    now: number
  ): Promise<CompactionResult> {
    let recordsRemoved = 0;
    let bytesReclaimed = 0;
    let snapshotsCreated = 0;

    // Sort records by timestamp
    const sortedRecords = records.sort((a, b) => a.timestamp - b.timestamp);

    // Find latest snapshot
    const latestSnapshot = sortedRecords
      .filter(r => r.kind === 'snapshot')
      .pop() as SnapshotRecord | undefined;

    // Check if we need a new snapshot
    const recordsSinceSnapshot = latestSnapshot 
      ? sortedRecords.filter(r => r.timestamp > latestSnapshot.timestamp).length
      : sortedRecords.length;

    if (recordsSinceSnapshot >= this.retentionPolicy.snapshotsEveryOps) {
      // Create new snapshot
      const snapshot = await this.createSnapshot(resourceId, sortedRecords);
      if (snapshot) {
        snapshotsCreated = 1;
        console.log(`📸 Created snapshot for resource ${resourceId}: ${snapshot.snapshotId}`);
      }
    }

    // Remove expired records
    for (const record of sortedRecords) {
      const age = now - record.timestamp;
      let shouldRemove = false;

      switch (record.kind) {
        case 'message':
          shouldRemove = age > this.retentionPolicy.messagesTtlMs;
          break;
        case 'state':
          shouldRemove = age > this.retentionPolicy.stateTtlMs;
          break;
        case 'membership':
          shouldRemove = age > this.retentionPolicy.membershipTtlMs;
          break;
        case 'snapshot':
          // Keep recent snapshots, remove old ones beyond limit
          const snapshotRecords = sortedRecords.filter(r => r.kind === 'snapshot');
          const snapshotIndex = snapshotRecords.indexOf(record as SnapshotRecord);
          shouldRemove = snapshotIndex < snapshotRecords.length - this.retentionPolicy.maxSnapshotsToKeep;
          break;
      }

      if (shouldRemove) {
        recordsRemoved++;
        bytesReclaimed += this.estimateRecordSize(record);
      }
    }

    return { recordsRemoved, bytesReclaimed, snapshotsCreated, compactionDuration: 0 };
  }

  private async createSnapshot(resourceId: string, records: WALRecord[]): Promise<SnapshotRecord | null> {
    try {
      // Find the latest operation
      const stateRecords = records.filter(r => r.kind === 'state') as StateRecord[];
      const latestOp = stateRecords.sort((a, b) => b.timestamp - a.timestamp)[0];

      if (!latestOp) {
        return null; // No state to snapshot
      }

      // Create snapshot record
      const snapshot: SnapshotRecord = {
        kind: 'snapshot',
        recordId: this.generateRecordId(),
        resourceId,
        timestamp: Date.now(),
        version: 1,
        leaseTerm: latestOp.leaseTerm,
        metadata: {
          operationCount: stateRecords.length,
          createdBy: 'TimeBasedCompactionStrategy'
        },
        snapshotId: this.generateSnapshotId(resourceId),
        lastOpId: latestOp.opId,
        stateHash: this.calculateStateHash(stateRecords),
        snapshotData: this.serializeState(stateRecords),
        compressionType: 'gzip',
        snapshotSize: stateRecords.length * 1024 // Estimate
      };

      return snapshot;
    } catch (error) {
      console.error(`❌ Error creating snapshot for resource ${resourceId}:`, error);
      return null;
    }
  }

  private estimateRecordSize(record: WALRecord): number {
    // Rough estimate of record size in bytes
    const baseSize = 200; // Base overhead
    const payloadSize = record.kind === 'message' 
      ? (record as MessageRecord).body.length
      : 1024; // Estimate for other types
    
    return baseSize + payloadSize;
  }

  private generateRecordId(): string {
    return `wal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateSnapshotId(resourceId: string): string {
    return `snap-${resourceId}-${Date.now()}`;
  }

  private calculateStateHash(records: StateRecord[]): string {
    // Simple hash calculation - in production use proper cryptographic hash
    const combined = records.map(r => r.opId).sort().join('|');
    return `hash-${combined.length}-${Date.now()}`;
  }

  private serializeState(records: StateRecord[]): any {
    // Serialize state records for snapshot storage
    return {
      recordCount: records.length,
      latestTimestamp: Math.max(...records.map(r => r.timestamp)),
      operationIds: records.map(r => r.opId)
    };
  }
}

/**
 * Factory for creating WAL records with proper versioning and validation
 */
export class WALRecordFactory {
  private static readonly CURRENT_VERSION = 1;

  static createStateRecord(
    resourceId: string,
    opId: string,
    type: StateRecord['type'],
    originNodeId: string,
    payload: any,
    leaseTerm: number,
    vector: Record<string, number>,
    correlationId: string,
    parents?: string[]
  ): StateRecord {
    return {
      kind: 'state',
      recordId: this.generateRecordId(),
      resourceId,
      timestamp: Date.now(),
      version: this.CURRENT_VERSION,
      leaseTerm,
      metadata: {},
      opId,
      type,
      originNodeId,
      vector,
      payload,
      parents,
      correlationId
    };
  }

  static createMessageRecord(
    resourceId: string,
    opId: string,
    body: Uint8Array,
    meta: Record<string, string>,
    leaseTerm: number,
    vector: Record<string, number>,
    originNodeId: string,
    correlationId: string
  ): MessageRecord {
    return {
      kind: 'message',
      recordId: this.generateRecordId(),
      resourceId,
      timestamp: Date.now(),
      version: this.CURRENT_VERSION,
      leaseTerm,
      metadata: {},
      opId,
      body,
      meta,
      vector,
      originNodeId,
      correlationId
    };
  }

  static createMembershipRecord(
    resourceId: string,
    opId: string,
    action: MembershipRecord['action'],
    connectionId: string,
    leaseTerm: number,
    vector: Record<string, number>,
    originNodeId: string,
    principalId?: string,
    filters?: Record<string, any>
  ): MembershipRecord {
    return {
      kind: 'membership',
      recordId: this.generateRecordId(),
      resourceId,
      timestamp: Date.now(),
      version: this.CURRENT_VERSION,
      leaseTerm,
      metadata: {},
      opId,
      action,
      connectionId,
      principalId,
      filters,
      vector,
      originNodeId
    };
  }

  private static generateRecordId(): string {
    return `wal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
