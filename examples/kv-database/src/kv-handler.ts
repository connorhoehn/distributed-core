/**
 * KVHandler -- a RangeHandler that implements a distributed key-value store.
 *
 * Each node owns a set of ranges. Keys are hashed to a range ID and the
 * owning node stores the value in a local StateStore instance.  When the
 * cluster topology changes the handler logs the rebalance event; range
 * data is kept in-memory for simplicity (a real system would stream
 * ranges during handoff).
 */
import {
  StateStore,
  FrameworkRangeHandler as RangeHandler,
  FrameworkClusterMessage as ClusterMessage,
  ClusterInfo,
  RangeId,
} from 'distributed-core';

/**
 * Message payload types understood by KVHandler.
 */
export interface KVSetPayload {
  key: string;
  value: string;
}

export interface KVGetPayload {
  key: string;
}

export interface KVDeletePayload {
  key: string;
}

/**
 * In-memory response accumulator -- since we are running everything in a
 * single process, handlers write their responses here so the KVClient can
 * read them synchronously after the message round-trip.
 */
export const responseStore = new Map<string, any>();

/**
 * Shared data store keyed by range -> StateStore.
 * Accessible for tests and the KVClient.
 */
export const rangeStores = new Map<string, StateStore>();

export class KVHandler implements RangeHandler {
  private assignedRanges: Set<string> = new Set();

  // ---- RangeHandler callbacks ----

  async onJoin(rangeId: RangeId, clusterInfo: ClusterInfo): Promise<void> {
    this.assignedRanges.add(rangeId);
    if (!rangeStores.has(rangeId)) {
      rangeStores.set(rangeId, new StateStore());
    }
  }

  async onMessage(message: ClusterMessage): Promise<void> {
    const { type, payload, id, targetRangeId } = message;
    const store = targetRangeId ? rangeStores.get(targetRangeId) : undefined;

    switch (type) {
      case 'SET': {
        const { key, value } = payload as KVSetPayload;
        if (store) {
          store.set(key, value);
          responseStore.set(id, { ok: true });
        } else {
          responseStore.set(id, { ok: false, error: 'range not found' });
        }
        break;
      }
      case 'GET': {
        const { key } = payload as KVGetPayload;
        if (store) {
          const value = store.get<string>(key);
          responseStore.set(id, { ok: true, value: value ?? null });
        } else {
          responseStore.set(id, { ok: false, error: 'range not found' });
        }
        break;
      }
      case 'DELETE': {
        const { key } = payload as KVDeletePayload;
        if (store) {
          const existed = store.get(key) !== undefined;
          store.delete(key);
          responseStore.set(id, { ok: true, deleted: existed });
        } else {
          responseStore.set(id, { ok: false, error: 'range not found' });
        }
        break;
      }
      default:
        responseStore.set(id, { ok: false, error: `unknown command: ${type}` });
    }
  }

  async onLeave(rangeId: RangeId): Promise<void> {
    this.assignedRanges.delete(rangeId);
    // In a production system, we would stream range data to the new owner
    // here.  For this example we leave the data in rangeStores so that
    // another node can pick it up after rebalancing.
  }

  async onTopologyChange(clusterInfo: ClusterInfo): Promise<void> {
    // Informational -- log rebalance events for visibility.
  }
}
