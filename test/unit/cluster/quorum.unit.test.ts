import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../../src/cluster/BootstrapConfig';
import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';
import { QuorumOptions } from '../../../src/cluster/types';

describe('ClusterManager Quorum Functionality', () => {
  let clusterManager: ClusterManager;
  let transport: InMemoryAdapter;
  let nodeId: string;
  let config: BootstrapConfig;

  beforeEach(async () => {
    nodeId = 'test-node';
    const nodeIdObj = { id: 'test-node', address: '127.0.0.1', port: 3000 };
    transport = new InMemoryAdapter(nodeIdObj);
    config = new BootstrapConfig([], 5000, 1000, false); // Enable logging=false for tests
    const nodeMetadata = { region: 'test-region', zone: 'test-zone', role: 'coordinator' };
    clusterManager = new ClusterManager(nodeId, transport, config, 100, nodeMetadata);
    
    await clusterManager.start();
  });

  afterEach(async () => {
    if (clusterManager) {
      await clusterManager.stop();
    }
  });

  describe('hasQuorum()', () => {
    it('should return true for single node cluster with minimum requirement', () => {
      const options: QuorumOptions = {
        minNodeCount: 1
      };

      const hasQuorum = clusterManager.hasQuorum(options);
      expect(hasQuorum).toBe(true);
    });

    it('should return false when minimum node count not met', () => {
      const optionsRequiringMoreNodes: QuorumOptions = {
        minNodeCount: 3
      };

      const hasQuorum = clusterManager.hasQuorum(optionsRequiringMoreNodes);
      expect(hasQuorum).toBe(false);
    });

    it('should check service-specific quorum requirements', () => {
      const options: QuorumOptions = {
        service: 'coordinator'
      };

      const hasQuorum = clusterManager.hasQuorum(options);
      expect(hasQuorum).toBe(true); // Single node cluster should have quorum
    });

    it('should check region count requirements', () => {
      const options: QuorumOptions = {
        requiredRegionCount: 2
      };

      const hasQuorum = clusterManager.hasQuorum(options);
      expect(hasQuorum).toBe(false); // Only one region (test-region)
    });
  });

  describe('runAntiEntropyCycle()', () => {
    it('should execute anti-entropy cycle without errors', () => {
      expect(() => {
        clusterManager.runAntiEntropyCycle();
      }).not.toThrow();
    });

    it('should execute anti-entropy cycle without throwing errors', () => {
      expect(() => {
        clusterManager.runAntiEntropyCycle();
      }).not.toThrow();
    });
  });

  describe('detectPartition()', () => {
    it('should return null for healthy single node cluster', () => {
      const partition = clusterManager.detectPartition();
      expect(partition).toBeNull();
    });

    it('should have partition detection functionality available', () => {
      expect(typeof clusterManager.detectPartition).toBe('function');
    });
  });
});
