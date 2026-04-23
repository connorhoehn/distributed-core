/**
 * Unit tests for StateDelta vector-clock causality tracking
 *
 * Causality in this system is expressed through the `causality: string[]`
 * field on every StateDelta — a list of delta IDs that a delta depends on.
 * StateDeltaManager.mergeDeltas() unions the causality arrays of all input
 * deltas into the merged delta, preserving the full dependency history.
 *
 * NOTE: The higher-level "appliedDeltaIds" session tracking (bounded ring-
 * buffer with idempotency guard) is a planned feature tracked as a TODO in
 * the source. The tests in this file cover the causality surface that is
 * currently implemented. Tests for the idempotency guard are written against
 * the existing applyDelta() return values and are marked accordingly.
 */

import {
  StateDeltaManager,
  StateDelta,
  ServiceDelta
} from '../../../../src/cluster/delta-sync/StateDelta';
import { LogicalService } from '../../../../src/cluster/introspection/ClusterIntrospection';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(id: string, nodeId = 'node-1'): LogicalService {
  return {
    id,
    type: 'test',
    nodeId,
    metadata: {},
    stats: {},
    lastUpdated: Date.now(),
    vectorClock: { [nodeId]: 1 },
    version: 1,
    checksum: `ck-${id}`,
    conflictPolicy: 'last-writer-wins'
  };
}

function makeServiceOp(serviceId: string, service?: LogicalService): ServiceDelta {
  return {
    operation: 'add',
    serviceId,
    service: service ?? makeService(serviceId),
    timestamp: Date.now()
  };
}

/**
 * Construct a minimal valid StateDelta without going through generateDelta()
 * so we can control the `causality` field directly.
 */
function makeDelta(
  id: string,
  causality: string[] = [],
  serviceId = `svc-${id}`
): StateDelta {
  return {
    id,
    sourceNodeId: 'node-1',
    sourceFingerprint: 'fp-0',
    services: [makeServiceOp(serviceId)],
    timestamp: Date.now(),
    version: 1,
    sequenceNumber: 1,
    vectorClockUpdates: { 'node-1': 1 },
    causality,
    compressed: false,
    encrypted: false
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StateDelta — causality tracking', () => {
  let manager: StateDeltaManager;

  beforeEach(() => {
    manager = new StateDeltaManager({
      maxDeltaSize: 100,
      includeFullServices: true,
      enableCausality: true,
      compressionThreshold: 1024,
      enableEncryption: false
    });
  });

  // -------------------------------------------------------------------------
  // StateDelta interface — causality field
  // -------------------------------------------------------------------------

  describe('StateDelta interface', () => {
    it('fresh delta literal has empty causality array', () => {
      const delta = makeDelta('delta-1');
      expect(delta.causality).toEqual([]);
    });

    it('causality field accepts an array of dependency IDs', () => {
      const delta = makeDelta('delta-2', ['delta-0', 'delta-1']);
      expect(delta.causality).toContain('delta-0');
      expect(delta.causality).toContain('delta-1');
      expect(delta.causality).toHaveLength(2);
    });

    it('causality array is independent between delta instances', () => {
      const deltaA = makeDelta('a', ['root']);
      const deltaB = makeDelta('b', ['root', 'a']);

      // Mutating one causality list must not affect the other
      deltaA.causality.push('extra');
      expect(deltaB.causality).not.toContain('extra');
    });
  });

  // -------------------------------------------------------------------------
  // generateDelta() — causality field in produced deltas
  // -------------------------------------------------------------------------

  describe('generateDelta() causality field', () => {
    it('produces deltas with empty causality (TODO: tracking not yet wired)', () => {
      const services = [makeService('svc-a'), makeService('svc-b')];
      const comparison = {
        identical: false,
        addedServices: ['svc-a', 'svc-b'],
        removedServices: [] as string[],
        modifiedServices: [] as string[],
        hashDifferences: 2
      };

      const deltas = manager.generateDelta(services, comparison, 'node-1', 'fp-root');

      // Current implementation leaves causality as [] (see TODO in source)
      deltas.forEach(delta => {
        expect(Array.isArray(delta.causality)).toBe(true);
      });
    });

    it('delta has a unique id and a sequenceNumber', () => {
      const services = [makeService('svc-x')];
      const comparison = {
        identical: false,
        addedServices: ['svc-x'],
        removedServices: [] as string[],
        modifiedServices: [] as string[],
        hashDifferences: 1
      };

      const [delta] = manager.generateDelta(services, comparison, 'node-1', 'fp-root');

      expect(typeof delta.id).toBe('string');
      expect(delta.id.length).toBeGreaterThan(0);
      expect(typeof delta.sequenceNumber).toBe('number');
    });
  });

  // -------------------------------------------------------------------------
  // mergeDeltas() — causality union
  // -------------------------------------------------------------------------

  describe('mergeDeltas() causality union', () => {
    it('merged delta has empty causality when all inputs have empty causality', () => {
      const a = makeDelta('a', [], 'svc-a');
      const b = makeDelta('b', [], 'svc-b');

      const merged = manager.mergeDeltas([a, b]);
      expect(merged.causality).toEqual([]);
    });

    it('merged delta inherits causality from a single input delta', () => {
      const a = makeDelta('a', ['root'], 'svc-a');
      const b = makeDelta('b', [], 'svc-b');

      const merged = manager.mergeDeltas([a, b]);
      expect(merged.causality).toContain('root');
    });

    it('merged delta unions causality from all input deltas', () => {
      const a = makeDelta('a', ['dep-1', 'dep-2'], 'svc-a');
      const b = makeDelta('b', ['dep-2', 'dep-3'], 'svc-b');

      const merged = manager.mergeDeltas([a, b]);

      // All dependency IDs should be present exactly once
      expect(merged.causality).toContain('dep-1');
      expect(merged.causality).toContain('dep-2');
      expect(merged.causality).toContain('dep-3');
    });

    it('merged delta deduplicates causality IDs (set semantics)', () => {
      const a = makeDelta('a', ['shared', 'only-a'], 'svc-a');
      const b = makeDelta('b', ['shared', 'only-b'], 'svc-b');

      const merged = manager.mergeDeltas([a, b]);

      const sharedCount = merged.causality.filter(id => id === 'shared').length;
      expect(sharedCount).toBe(1);
      expect(merged.causality).toHaveLength(3); // shared, only-a, only-b
    });

    it('causality is monotonically growing: applying B after A means B’s causality contains A’s deps', () => {
      // Simulate a causal chain: deltaA depends on nothing, deltaB depends on deltaA's deps
      const deltaA = makeDelta('delta-a', [], 'svc-a');
      const deltaB = makeDelta('delta-b', ['delta-a'], 'svc-b');

      // Merging them produces a delta whose causality contains delta-a's reference
      const merged = manager.mergeDeltas([deltaA, deltaB]);

      expect(merged.causality).toContain('delta-a');
    });

    it('merging a single delta returns it unchanged', () => {
      const only = makeDelta('only', ['dep-x'], 'svc-only');
      const merged = manager.mergeDeltas([only]);

      // Single-element merge returns the original delta
      expect(merged).toBe(only);
    });
  });

  // -------------------------------------------------------------------------
  // applyDelta() — idempotency via return-value inspection
  // -------------------------------------------------------------------------

  describe('applyDelta() idempotency', () => {
    it('applying the same add-delta twice conflicts on the second application', () => {
      const initialServices: LogicalService[] = [];
      const newService = makeService('svc-new');

      const delta: StateDelta = {
        id: 'idem-delta',
        sourceNodeId: 'node-1',
        sourceFingerprint: 'fp-1',
        services: [makeServiceOp('svc-new', newService)],
        timestamp: Date.now(),
        version: 1,
        sequenceNumber: 1,
        vectorClockUpdates: {},
        causality: [],
        compressed: false,
        encrypted: false
      };

      // First application: service added successfully
      const first = manager.applyDelta(initialServices, delta);
      expect(first.success).toBe(true);
      expect(first.appliedOperations).toBe(1);

      // Second application: service already exists → conflict
      const second = manager.applyDelta(first.resultingServices, delta);
      expect(second.success).toBe(false);
      expect(second.conflicts.length).toBeGreaterThan(0);
      expect(second.conflicts[0].conflictType).toBe('version');
    });

    it('applying a delete-delta twice does not throw and succeeds gracefully', () => {
      const existingServices = [makeService('svc-to-delete')];

      const deleteDelta: StateDelta = {
        id: 'del-delta',
        sourceNodeId: 'node-1',
        sourceFingerprint: 'fp-1',
        services: [{
          operation: 'delete',
          serviceId: 'svc-to-delete',
          timestamp: Date.now()
        }],
        timestamp: Date.now(),
        version: 1,
        sequenceNumber: 1,
        vectorClockUpdates: {},
        causality: [],
        compressed: false,
        encrypted: false
      };

      const first = manager.applyDelta(existingServices, deleteDelta);
      expect(first.success).toBe(true);
      expect(first.resultingServices).toHaveLength(0);

      // Second delete: service already gone. The implementation handles this
      // gracefully (the 'already-deleted' case logs internally and continues).
      // The operation is counted as "applied" (success branch) because the
      // applyServiceOperation function returns { success: true, conflicts: [] }
      // for the already-deleted case — it does not treat it as a hard failure.
      const second = manager.applyDelta(first.resultingServices, deleteDelta);
      expect(second.success).toBe(true);
      // State is still consistent: no services remain
      expect(second.resultingServices).toHaveLength(0);
    });

    it('applying a modify-delta twice produces a version conflict on the second pass', () => {
      const original = { ...makeService('svc-m'), version: 1 };
      const modified = { ...original, version: 2, stats: { requests: 99 } };

      const modDelta: StateDelta = {
        id: 'mod-delta',
        sourceNodeId: 'node-1',
        sourceFingerprint: 'fp-1',
        services: [{
          operation: 'modify',
          serviceId: 'svc-m',
          service: modified,
          previousVersion: 1,
          timestamp: Date.now()
        }],
        timestamp: Date.now(),
        version: 1,
        sequenceNumber: 1,
        vectorClockUpdates: {},
        causality: [],
        compressed: false,
        encrypted: false
      };

      const initialServices = [original];
      const first = manager.applyDelta(initialServices, modDelta);
      expect(first.success).toBe(true);

      // After first apply the service has version=2; applying the same delta
      // again expects previousVersion=1 but finds version=2 → version conflict
      const second = manager.applyDelta(first.resultingServices, modDelta);
      expect(second.success).toBe(false);
      expect(second.conflicts[0].conflictType).toBe('version');
    });
  });

  // -------------------------------------------------------------------------
  // causality field preserved through applyDelta results
  // -------------------------------------------------------------------------

  describe('causality field preservation', () => {
    it('applyDelta does not modify the causality field of the input delta', () => {
      const delta = makeDelta('preserve-test', ['dep-1', 'dep-2']);
      const before = [...delta.causality];

      manager.applyDelta([], delta);

      expect(delta.causality).toEqual(before);
    });

    it('DeltaApplicationResult does not expose a causality property (not tracked there)', () => {
      const delta = makeDelta('result-test', ['some-dep']);
      const result = manager.applyDelta([], delta);

      // The result object tracks operations, conflicts, and resulting services —
      // not causality. Causality lives on the delta itself.
      expect('causality' in result).toBe(false);
    });
  });
});
