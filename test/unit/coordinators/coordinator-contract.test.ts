import { IClusterCoordinator } from '../../../src/coordinators/types';
import { InMemoryCoordinator } from '../../../src/coordinators/InMemoryCoordinator';
import { EtcdCoordinator } from '../../../src/coordinators/EtcdCoordinator';
import { ZookeeperCoordinator } from '../../../src/coordinators/ZookeeperCoordinator';

/**
 * Shared contract test suite that verifies ANY IClusterCoordinator implementation
 * satisfies the interface contract. Uses a factory function pattern so the same
 * tests can run against InMemory, Etcd (stub), and ZooKeeper (stub).
 *
 * When real implementations are available, add them here with their own factory
 * (e.g. using a mock etcd client) and the contract tests automatically apply.
 */

interface CoordinatorFactory {
  /** Human-readable name for test output */
  name: string;
  /** Create a fresh coordinator instance */
  create(): IClusterCoordinator;
  /** Default config to pass to initialize() */
  config: Record<string, any>;
  /**
   * Whether this implementation actually acquires leases.
   * Stubs that always return false should set this to false so
   * lease-specific assertions are skipped.
   */
  supportsLeaseAcquisition: boolean;
  /**
   * Whether this implementation tracks cluster membership.
   * Stubs that return empty node maps should set this to false.
   */
  tracksMembership: boolean;
}

function coordinatorContractSuite(factory: CoordinatorFactory) {
  describe(`IClusterCoordinator contract: ${factory.name}`, () => {
    let coordinator: IClusterCoordinator;

    beforeEach(async () => {
      coordinator = factory.create();
      await coordinator.initialize('node-1', 'ring-contract', factory.config);
    });

    afterEach(async () => {
      await coordinator.stop();
    });

    // ---------------------------------------------------------------
    // initialize + joinCluster
    // ---------------------------------------------------------------
    describe('initialize and joinCluster', () => {
      test('should not throw on joinCluster with empty seed list', async () => {
        await coordinator.joinCluster([]);
      });

      test('should not throw on joinCluster with seed nodes', async () => {
        await coordinator.joinCluster(['seed-a', 'seed-b']);
      });
    });

    // ---------------------------------------------------------------
    // getClusterView()
    // ---------------------------------------------------------------
    describe('getClusterView()', () => {
      test('should return a ClusterView with required fields', async () => {
        await coordinator.joinCluster([]);
        const view = await coordinator.getClusterView();

        expect(view.nodes).toBeInstanceOf(Map);
        expect(view.leases).toBeInstanceOf(Map);
        expect(typeof view.ringId).toBe('string');
        expect(typeof view.version).toBe('number');
        expect(typeof view.lastUpdated).toBe('number');
      });

      if (factory.tracksMembership) {
        test('cluster view should contain at least this node after join', async () => {
          await coordinator.joinCluster([]);
          const view = await coordinator.getClusterView();
          expect(view.nodes.size).toBeGreaterThanOrEqual(1);
        });
      }
    });

    // ---------------------------------------------------------------
    // Lease operations
    // ---------------------------------------------------------------
    describe('acquireLease / releaseLease / ownsRange / getOwnedRanges', () => {
      beforeEach(async () => {
        await coordinator.joinCluster([]);
        await coordinator.start();
      });

      test('acquireLease should return a boolean', async () => {
        const result = await coordinator.acquireLease('range-0');
        expect(typeof result).toBe('boolean');
      });

      test('releaseLease should not throw for any rangeId', async () => {
        await coordinator.releaseLease('range-nonexistent');
      });

      test('ownsRange should return a boolean', async () => {
        const result = await coordinator.ownsRange('range-0');
        expect(typeof result).toBe('boolean');
      });

      test('getOwnedRanges should return an array', async () => {
        const ranges = await coordinator.getOwnedRanges();
        expect(Array.isArray(ranges)).toBe(true);
      });

      if (factory.supportsLeaseAcquisition) {
        test('acquiring a lease means ownsRange returns true', async () => {
          const acquired = await coordinator.acquireLease('range-0');
          expect(acquired).toBe(true);
          expect(await coordinator.ownsRange('range-0')).toBe(true);
        });

        test('releasing a lease means ownsRange returns false', async () => {
          await coordinator.acquireLease('range-0');
          await coordinator.releaseLease('range-0');
          expect(await coordinator.ownsRange('range-0')).toBe(false);
        });

        test('getOwnedRanges reflects acquired leases', async () => {
          await coordinator.acquireLease('range-a');
          await coordinator.acquireLease('range-b');
          const ranges = await coordinator.getOwnedRanges();
          expect(ranges).toContain('range-a');
          expect(ranges).toContain('range-b');
        });

        test('getOwnedRanges does not include released leases', async () => {
          await coordinator.acquireLease('range-a');
          await coordinator.acquireLease('range-b');
          await coordinator.releaseLease('range-a');
          const ranges = await coordinator.getOwnedRanges();
          expect(ranges).not.toContain('range-a');
          expect(ranges).toContain('range-b');
        });
      }
    });

    // ---------------------------------------------------------------
    // leaveCluster
    // ---------------------------------------------------------------
    describe('leaveCluster', () => {
      test('should not throw', async () => {
        await coordinator.joinCluster([]);
        await coordinator.leaveCluster();
      });

      if (factory.supportsLeaseAcquisition) {
        test('leaveCluster should release all owned ranges', async () => {
          await coordinator.joinCluster([]);
          await coordinator.start();
          await coordinator.acquireLease('range-0');
          await coordinator.leaveCluster();

          const ranges = await coordinator.getOwnedRanges();
          expect(ranges).toEqual([]);
        });
      }
    });

    // ---------------------------------------------------------------
    // start / stop lifecycle
    // ---------------------------------------------------------------
    describe('start / stop lifecycle', () => {
      test('start is idempotent', async () => {
        await coordinator.start();
        await coordinator.start();
      });

      test('stop is idempotent', async () => {
        await coordinator.start();
        await coordinator.stop();
        await coordinator.stop();
      });

      test('stop without prior start does not throw', async () => {
        await coordinator.stop();
      });
    });

    // ---------------------------------------------------------------
    // Event emitter interface
    // ---------------------------------------------------------------
    describe('event emitter interface', () => {
      test('should support on / off / emit', () => {
        expect(typeof coordinator.on).toBe('function');
        expect(typeof coordinator.off).toBe('function');
        expect(typeof coordinator.emit).toBe('function');
      });

      test('on registers a listener that receives events', () => {
        const received: any[] = [];
        const listener = (...args: any[]) => received.push(args);

        coordinator.on('node-joined', listener);
        coordinator.emit('node-joined', 'test-node');

        expect(received).toHaveLength(1);
        expect(received[0]).toEqual(['test-node']);
      });

      test('off removes a listener', () => {
        const received: any[] = [];
        const listener = (...args: any[]) => received.push(args);

        coordinator.on('node-joined', listener);
        coordinator.off('node-joined', listener);
        coordinator.emit('node-joined', 'test-node');

        expect(received).toHaveLength(0);
      });
    });
  });
}

// ---------------------------------------------------------------
// Run the contract suite against each implementation
// ---------------------------------------------------------------

const suppressLogs = {
  logging: { enableFrameworkLogs: false, enableCoordinatorLogs: false },
};

coordinatorContractSuite({
  name: 'InMemoryCoordinator',
  create: () => new InMemoryCoordinator(),
  config: {
    testMode: true,
    heartbeatIntervalMs: 100,
    leaseRenewalIntervalMs: 200,
    leaseTimeoutMs: 1000,
    ...suppressLogs,
  },
  supportsLeaseAcquisition: true,
  tracksMembership: true,
});

coordinatorContractSuite({
  name: 'EtcdCoordinator (in-memory)',
  create: () => new EtcdCoordinator(new (require('../../../src/coordinators/EtcdCoordinator').InMemoryEtcdClient)()),
  config: { ...suppressLogs },
  supportsLeaseAcquisition: false,
  tracksMembership: true, // Etcd stub includes self in getClusterView
});

coordinatorContractSuite({
  name: 'ZookeeperCoordinator (in-memory)',
  create: () => new ZookeeperCoordinator(new (require('../../../src/coordinators/ZookeeperCoordinator').InMemoryZookeeperClient)()),
  config: { ...suppressLogs },
  supportsLeaseAcquisition: false,
  tracksMembership: false, // ZK stub returns empty node map
});
