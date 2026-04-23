/**
 * Unit tests for MultiLevelQuorumStrategy
 *
 * Focuses on the canTolerateFailures() region/zone simulation and the
 * multi-level quorum evaluation logic.
 *
 * Test fixture: 9-node cluster across 3 regions × 3 zones (3 nodes per
 * region, 1 per zone):
 *
 *   region-1: node-1 (zone-a), node-2 (zone-b), node-3 (zone-c)
 *   region-2: node-4 (zone-d), node-5 (zone-e), node-6 (zone-f)
 *   region-3: node-7 (zone-g), node-8 (zone-h), node-9 (zone-i)
 */

import { MultiLevelQuorumStrategy } from '../../../../src/cluster/quorum/MultiLevelQuorumStrategy';
import { MembershipEntry } from '../../../../src/cluster/types';
import { MultiLevelQuorumOptions } from '../../../../src/cluster/quorum/types';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeNode(
  id: string,
  region: string,
  zone: string,
  status: MembershipEntry['status'] = 'ALIVE'
): MembershipEntry {
  return {
    id,
    status,
    lastSeen: Date.now(),
    version: 1,
    lastUpdated: Date.now(),
    metadata: { region, zone }
  };
}

/**
 * 9-node cluster: 3 regions × 3 zones, 3 nodes per region, 1 per zone.
 */
function makeNineNodeCluster(): MembershipEntry[] {
  return [
    // region-1
    makeNode('node-1', 'region-1', 'zone-a'),
    makeNode('node-2', 'region-1', 'zone-b'),
    makeNode('node-3', 'region-1', 'zone-c'),
    // region-2
    makeNode('node-4', 'region-2', 'zone-d'),
    makeNode('node-5', 'region-2', 'zone-e'),
    makeNode('node-6', 'region-2', 'zone-f'),
    // region-3
    makeNode('node-7', 'region-3', 'zone-g'),
    makeNode('node-8', 'region-3', 'zone-h'),
    makeNode('node-9', 'region-3', 'zone-i')
  ];
}

/** Standard options for the 9-node fixture. */
const standardOptions: MultiLevelQuorumOptions = {
  clusterLevel: { minNodes: 5, strategy: 'majority' },
  regionLevel: { requiredRegions: 2, minNodesPerRegion: 1 },
  zoneLevel: { requiredZones: 5, minNodesPerZone: 1 }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MultiLevelQuorumStrategy', () => {
  let strategy: MultiLevelQuorumStrategy;
  let nineNodes: MembershipEntry[];

  beforeEach(() => {
    strategy = new MultiLevelQuorumStrategy();
    nineNodes = makeNineNodeCluster();
  });

  // -------------------------------------------------------------------------
  // Strategy identity
  // -------------------------------------------------------------------------

  describe('name', () => {
    it('should report strategy name as "multi-level"', () => {
      expect(strategy.name).toBe('multi-level');
    });
  });

  // -------------------------------------------------------------------------
  // evaluate() — multi-level quorum assessment
  // -------------------------------------------------------------------------

  describe('evaluate()', () => {
    it('returns hasQuorum=true when all levels pass for a healthy cluster', () => {
      const result = strategy.evaluate(nineNodes, standardOptions);

      expect(result.hasQuorum).toBe(true);
      expect(result.strategy).toBe('multi-level');
    });

    it('includes cluster, region, and zone sub-results in metadata', () => {
      const result = strategy.evaluate(nineNodes, standardOptions);

      expect(result.metadata).toBeDefined();
      expect(result.metadata!.clusterQuorum).toBeDefined();
      expect(result.metadata!.regionQuorum).toBeDefined();
      expect(result.metadata!.zoneQuorum).toBeDefined();
    });

    it('returns hasQuorum=false when cluster level fails (simple strategy, minNodes not met)', () => {
      // Use simple strategy: minNodes=8 but only 4 alive → fails
      const degraded = nineNodes.map((n, i) =>
        i < 5 ? { ...n, status: 'DEAD' as const } : n
      );

      const options: MultiLevelQuorumOptions = {
        clusterLevel: { minNodes: 8, strategy: 'simple' },
        regionLevel: { requiredRegions: 1, minNodesPerRegion: 1 },
        zoneLevel: { requiredZones: 1, minNodesPerZone: 1 }
      };

      const result = strategy.evaluate(degraded, options);

      // 4 alive < 8 required → cluster level fails
      expect(result.hasQuorum).toBe(false);
      expect(result.metadata!.clusterQuorum.passed).toBe(false);
    });

    it('returns hasQuorum=false when region level fails', () => {
      // Only region-1 has alive nodes → 1 region, but requiredRegions=2
      const onlyRegion1 = nineNodes.map(n =>
        n.metadata?.region === 'region-1'
          ? n
          : { ...n, status: 'DEAD' as const }
      );

      const options: MultiLevelQuorumOptions = {
        clusterLevel: { minNodes: 1, strategy: 'simple' },
        regionLevel: { requiredRegions: 2, minNodesPerRegion: 1 },
        zoneLevel: { requiredZones: 1, minNodesPerZone: 1 }
      };

      const result = strategy.evaluate(onlyRegion1, options);

      expect(result.hasQuorum).toBe(false);
      expect(result.metadata!.regionQuorum.passed).toBe(false);
    });

    it('returns hasQuorum=false when zone level fails', () => {
      // All alive but require 10 zones when only 9 exist
      const options: MultiLevelQuorumOptions = {
        clusterLevel: { minNodes: 1, strategy: 'simple' },
        regionLevel: { requiredRegions: 1, minNodesPerRegion: 1 },
        zoneLevel: { requiredZones: 10, minNodesPerZone: 1 }
      };

      const result = strategy.evaluate(nineNodes, options);

      expect(result.hasQuorum).toBe(false);
      expect(result.metadata!.zoneQuorum.passed).toBe(false);
    });

    it('ALL levels must pass — quorum fails if any single level fails', () => {
      // Cluster level passes (9 >= 5), region level passes (3 regions),
      // zone level fails (require 10, only 9 available)
      const options: MultiLevelQuorumOptions = {
        clusterLevel: { minNodes: 5, strategy: 'simple' },
        regionLevel: { requiredRegions: 3, minNodesPerRegion: 1 },
        zoneLevel: { requiredZones: 10, minNodesPerZone: 1 }
      };

      const result = strategy.evaluate(nineNodes, options);

      expect(result.metadata!.clusterQuorum.passed).toBe(true);
      expect(result.metadata!.regionQuorum.passed).toBe(true);
      expect(result.metadata!.zoneQuorum.passed).toBe(false);
      expect(result.hasQuorum).toBe(false);
    });

    it('majority strategy computes floor(n/2)+1 at cluster level', () => {
      // 9 alive → majority = floor(9/2)+1 = 5
      const options: MultiLevelQuorumOptions = {
        clusterLevel: { minNodes: 999, strategy: 'majority' }, // minNodes ignored for majority
        regionLevel: { requiredRegions: 1, minNodesPerRegion: 1 },
        zoneLevel: { requiredZones: 1, minNodesPerZone: 1 }
      };

      const result = strategy.evaluate(nineNodes, options);

      // majority of 9 = 5; 9 >= 5 → cluster passes
      expect(result.metadata!.clusterQuorum.passed).toBe(true);
      expect(result.metadata!.clusterQuorum.required).toBe(5);
    });

    it('excludes DEAD / non-ALIVE members from all evaluations', () => {
      const withDeadNodes = nineNodes.map((n, i) =>
        i >= 7 ? { ...n, status: 'DEAD' as const } : n
      );
      // 7 alive

      const options: MultiLevelQuorumOptions = {
        clusterLevel: { minNodes: 7, strategy: 'simple' },
        regionLevel: { requiredRegions: 1, minNodesPerRegion: 1 },
        zoneLevel: { requiredZones: 1, minNodesPerZone: 1 }
      };

      const result = strategy.evaluate(withDeadNodes, options);

      expect(result.currentCount).toBe(7);
      expect(result.metadata!.clusterQuorum.passed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // canTolerateFailures()
  // -------------------------------------------------------------------------

  describe('canTolerateFailures()', () => {
    describe('no failures specified', () => {
      it('returns true for a healthy cluster when no failures are simulated', () => {
        const result = strategy.canTolerateFailures(nineNodes, standardOptions, {
          nodes: 0,
          zones: 0,
          regions: 0
        });

        expect(result).toBe(true);
      });

      it('returns true when failures object is empty (all defaults to 0)', () => {
        const result = strategy.canTolerateFailures(nineNodes, standardOptions, {});
        expect(result).toBe(true);
      });
    });

    describe('node-level failures', () => {
      it('returns true when removing N nodes still satisfies clusterLevel.minNodes', () => {
        // 9 alive, minNodes=5; remove 4 → 5 remaining ≥ 5
        const options: MultiLevelQuorumOptions = {
          ...standardOptions,
          clusterLevel: { minNodes: 5, strategy: 'simple' }
        };

        const result = strategy.canTolerateFailures(nineNodes, options, { nodes: 4 });
        expect(result).toBe(true);
      });

      it('returns false when removing N nodes drops below clusterLevel.minNodes', () => {
        // 9 alive, minNodes=5; remove 5 → 4 remaining < 5
        const options: MultiLevelQuorumOptions = {
          ...standardOptions,
          clusterLevel: { minNodes: 5, strategy: 'simple' }
        };

        const result = strategy.canTolerateFailures(nineNodes, options, { nodes: 5 });
        expect(result).toBe(false);
      });

      it('clamps remaining nodes to 0 (never negative)', () => {
        // Remove more nodes than exist — should not throw and should fail
        const options: MultiLevelQuorumOptions = {
          ...standardOptions,
          clusterLevel: { minNodes: 1, strategy: 'simple' }
        };

        const result = strategy.canTolerateFailures(nineNodes, options, { nodes: 100 });
        expect(result).toBe(false);
      });
    });

    describe('region-level failures (current implementation: node subtraction)', () => {
      /**
       * NOTE: The current canTolerateFailures() implementation simulates region
       * failures by subtracting (failures.nodes || 0) from the alive node count.
       * Full region/zone simulation is tracked as a TODO in the source. These
       * tests verify the current observable behaviour; they will need to be
       * revisited once that logic is implemented.
       */

      it('returns true when one region failure does not break node-count quorum', () => {
        // With the current stub: regions=1 is treated like nodes=0
        const options: MultiLevelQuorumOptions = {
          ...standardOptions,
          clusterLevel: { minNodes: 5, strategy: 'simple' }
        };

        // 9 alive, 0 nodes removed, minNodes=5 → still passes
        const result = strategy.canTolerateFailures(nineNodes, options, { regions: 1 });
        expect(result).toBe(true);
      });

      it('returns false when alive nodes (after node removals) fall below minNodes', () => {
        const options: MultiLevelQuorumOptions = {
          ...standardOptions,
          clusterLevel: { minNodes: 8, strategy: 'simple' }
        };

        // 9 alive, remove 2 nodes → 7 < 8 → false
        const result = strategy.canTolerateFailures(nineNodes, options, {
          nodes: 2,
          regions: 1
        });
        expect(result).toBe(false);
      });
    });

    describe('zone-level failures (current implementation: node subtraction)', () => {
      it('returns true when one zone failure does not break node-count quorum', () => {
        const options: MultiLevelQuorumOptions = {
          ...standardOptions,
          clusterLevel: { minNodes: 5, strategy: 'simple' }
        };

        // zones=1 alone → no node removal in current stub → 9 >= 5 → true
        const result = strategy.canTolerateFailures(nineNodes, options, { zones: 1 });
        expect(result).toBe(true);
      });
    });

    describe('combined failure scenarios', () => {
      it('combining region and node failures does not double-count node removals', () => {
        // regions=1 is treated as 0 extra node removals; nodes=3 removes 3
        // 9 - 3 = 6 ≥ 5 → true
        const options: MultiLevelQuorumOptions = {
          ...standardOptions,
          clusterLevel: { minNodes: 5, strategy: 'simple' }
        };

        const result = strategy.canTolerateFailures(nineNodes, options, {
          nodes: 3,
          regions: 1
        });
        expect(result).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  // getQuorumBreakdown()
  // -------------------------------------------------------------------------

  describe('getQuorumBreakdown()', () => {
    it('returns the same metadata as evaluate()', () => {
      const evaluateResult = strategy.evaluate(nineNodes, standardOptions);
      const breakdown = strategy.getQuorumBreakdown(nineNodes, standardOptions);

      expect(breakdown).toEqual(evaluateResult.metadata);
    });

    it('includes breakdown string summaries', () => {
      const breakdown = strategy.getQuorumBreakdown(nineNodes, standardOptions);

      expect(breakdown!.breakdown).toBeDefined();
      expect(typeof breakdown!.breakdown.cluster).toBe('string');
      expect(typeof breakdown!.breakdown.regions).toBe('string');
      expect(typeof breakdown!.breakdown.zones).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // Region-level evaluation detail
  // -------------------------------------------------------------------------

  describe('region-level quorum evaluation', () => {
    it('counts valid regions (those meeting minNodesPerRegion threshold)', () => {
      // region-1 has 3 nodes, region-2 has 3, region-3 has 3
      const options: MultiLevelQuorumOptions = {
        clusterLevel: { minNodes: 1, strategy: 'simple' },
        regionLevel: { requiredRegions: 3, minNodesPerRegion: 2 },
        zoneLevel: { requiredZones: 1, minNodesPerZone: 1 }
      };

      const result = strategy.evaluate(nineNodes, options);

      // All 3 regions have 3 nodes ≥ 2 → valid; 3 ≥ 3 required → passes
      expect(result.metadata!.regionQuorum.passed).toBe(true);
      expect(result.metadata!.regionQuorum.count).toBe(3);
    });

    it('disqualifies a region that has fewer nodes than minNodesPerRegion', () => {
      // Kill 2 nodes in region-1 → it has only 1 alive node
      const degraded = nineNodes.map(n =>
        (n.id === 'node-1' || n.id === 'node-2')
          ? { ...n, status: 'DEAD' as const }
          : n
      );

      const options: MultiLevelQuorumOptions = {
        clusterLevel: { minNodes: 1, strategy: 'simple' },
        regionLevel: { requiredRegions: 3, minNodesPerRegion: 2 },
        zoneLevel: { requiredZones: 1, minNodesPerZone: 1 }
      };

      const result = strategy.evaluate(degraded, options);

      // region-1 has only 1 node < 2 required → not counted
      // only 2 valid regions < 3 required → fails
      expect(result.metadata!.regionQuorum.passed).toBe(false);
      expect(result.metadata!.regionQuorum.count).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Zone-level evaluation detail
  // -------------------------------------------------------------------------

  describe('zone-level quorum evaluation', () => {
    it('counts each unique zone independently', () => {
      // 9 nodes across 9 unique zones (zone-a … zone-i)
      const options: MultiLevelQuorumOptions = {
        clusterLevel: { minNodes: 1, strategy: 'simple' },
        regionLevel: { requiredRegions: 1, minNodesPerRegion: 1 },
        zoneLevel: { requiredZones: 9, minNodesPerZone: 1 }
      };

      const result = strategy.evaluate(nineNodes, options);

      expect(result.metadata!.zoneQuorum.passed).toBe(true);
      expect(result.metadata!.zoneQuorum.count).toBe(9);
    });

    it('fails zone quorum when too many zones are required', () => {
      const options: MultiLevelQuorumOptions = {
        clusterLevel: { minNodes: 1, strategy: 'simple' },
        regionLevel: { requiredRegions: 1, minNodesPerRegion: 1 },
        zoneLevel: { requiredZones: 10, minNodesPerZone: 1 }
      };

      const result = strategy.evaluate(nineNodes, options);

      expect(result.metadata!.zoneQuorum.passed).toBe(false);
    });
  });
});
