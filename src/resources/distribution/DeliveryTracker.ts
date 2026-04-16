import { EventEmitter } from 'events';

/**
 * Receipt tracking the ACK status of a single operation to a single node.
 */
export interface DeliveryReceipt {
  opId: string;
  nodeId: string;
  status: 'pending' | 'acked' | 'failed' | 'timeout';
  timestamp: number;
  reason?: string;
}

/** Default timeout for delivery ACKs (5 seconds). */
const DEFAULT_TIMEOUT_MS = 5000;

interface PendingDelivery {
  resolve: (receipts: DeliveryReceipt[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  receipts: DeliveryReceipt[];
  expectedCount: number;
  ackedCount: number;
}

/**
 * DeliveryTracker provides best-effort delivery confirmation for resource operations
 * sent to remote cluster nodes.
 *
 * Usage:
 *   1. After fanning out an operation, call trackDelivery(opId, targetNodes).
 *   2. When an ACK/NACK message arrives from a remote node, call receiveAck/receiveNack.
 *   3. The returned promise resolves when all targets respond or the timeout expires.
 *
 * Events:
 *   - 'delivery:complete' (opId, receipts)  - all targets responded
 *   - 'delivery:timeout'  (opId, receipts)  - timeout before all responded
 *   - 'delivery:ack'      (opId, nodeId)    - single node ACK received
 *   - 'delivery:nack'     (opId, nodeId, reason) - single node NACK received
 */
export class DeliveryTracker extends EventEmitter {
  private pending: Map<string, PendingDelivery> = new Map();
  private defaultTimeoutMs: number;

  constructor(options?: { defaultTimeoutMs?: number }) {
    super();
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Track a sent operation. Returns a promise that resolves with receipts
   * once all target nodes have ACKed/NACKed or the timeout fires.
   */
  trackDelivery(opId: string, targetNodes: string[], timeoutMs?: number): Promise<DeliveryReceipt[]> {
    // If no targets, resolve immediately with empty receipts
    if (targetNodes.length === 0) {
      return Promise.resolve([]);
    }

    return new Promise<DeliveryReceipt[]>((resolve, reject) => {
      const now = Date.now();
      const receipts: DeliveryReceipt[] = targetNodes.map(nodeId => ({
        opId,
        nodeId,
        status: 'pending',
        timestamp: now,
      }));

      const timeout = timeoutMs ?? this.defaultTimeoutMs;
      const timer = setTimeout(() => {
        this.handleTimeout(opId);
      }, timeout);

      this.pending.set(opId, {
        resolve,
        reject,
        timer,
        receipts,
        expectedCount: targetNodes.length,
        ackedCount: 0,
      });
    });
  }

  /**
   * Called when an ACK message arrives from a target node.
   */
  receiveAck(opId: string, nodeId: string): void {
    const entry = this.pending.get(opId);
    if (!entry) return; // Unknown or already completed

    const receipt = entry.receipts.find(r => r.nodeId === nodeId && r.status === 'pending');
    if (!receipt) return; // Already handled or unknown node

    receipt.status = 'acked';
    receipt.timestamp = Date.now();
    entry.ackedCount++;

    this.emit('delivery:ack', opId, nodeId);
    this.checkCompletion(opId, entry);
  }

  /**
   * Called when a NACK or error arrives from a target node.
   */
  receiveNack(opId: string, nodeId: string, reason: string): void {
    const entry = this.pending.get(opId);
    if (!entry) return;

    const receipt = entry.receipts.find(r => r.nodeId === nodeId && r.status === 'pending');
    if (!receipt) return;

    receipt.status = 'failed';
    receipt.timestamp = Date.now();
    receipt.reason = reason;
    entry.ackedCount++;

    this.emit('delivery:nack', opId, nodeId, reason);
    this.checkCompletion(opId, entry);
  }

  /**
   * Check whether all targets have responded. If so, resolve and clean up.
   */
  private checkCompletion(opId: string, entry: PendingDelivery): void {
    if (entry.ackedCount >= entry.expectedCount) {
      clearTimeout(entry.timer);
      this.pending.delete(opId);
      this.emit('delivery:complete', opId, entry.receipts);
      entry.resolve(entry.receipts);
    }
  }

  /**
   * Handle timeout: mark remaining pending receipts as 'timeout' and resolve.
   */
  private handleTimeout(opId: string): void {
    const entry = this.pending.get(opId);
    if (!entry) return;

    for (const receipt of entry.receipts) {
      if (receipt.status === 'pending') {
        receipt.status = 'timeout';
        receipt.timestamp = Date.now();
      }
    }

    this.pending.delete(opId);
    this.emit('delivery:timeout', opId, entry.receipts);
    entry.resolve(entry.receipts); // Resolve (not reject) -- best-effort
  }

  /**
   * Get the number of operations currently awaiting ACKs.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Cancel tracking for an operation (e.g., if it was retried elsewhere).
   */
  cancel(opId: string): void {
    const entry = this.pending.get(opId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(opId);
  }

  /**
   * Clean up all pending trackers.
   */
  destroy(): void {
    for (const [opId, entry] of this.pending) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
    this.removeAllListeners();
  }
}
