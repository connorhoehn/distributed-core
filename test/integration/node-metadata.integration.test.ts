import { Node } from '../../src/common/Node';
import { InMemoryAdapter } from '../../src/transport/adapters/InMemoryAdapter';

describe('Node Integration Tests', () => {
  let node: Node;

  afterEach(async () => {
    if (node && node.isRunning()) {
      await node.stop();
    }
  });

  describe('NodeMetadata Integration', () => {
    it('should create node with minimal NodeMetadata configuration', async () => {
      node = new Node({ 
        id: 'test-node-1',
        region: 'us-east-1',
        zone: 'us-east-1a'
      });
      
      expect(node.id).toBe('test-node-1');
      expect(node.metadata).toBeDefined();
      expect(node.metadata.nodeId).toBe('test-node-1');
      expect(node.metadata.region).toBe('us-east-1');
      expect(node.metadata.zone).toBe('us-east-1a');
      expect(node.metadata.clusterId).toBe('default-cluster');
      expect(node.metadata.service).toBe('distributed-core');
      expect(node.metadata.version).toBe('v1.0.0');
      expect(node.metadata.startTime).toBeGreaterThan(0);
      expect(node.metadata.incarnation).toBe(0);
    });

    it('should create node with full NodeMetadata configuration', async () => {
      const transport = new InMemoryAdapter({
        id: 'full-config-node',
        address: 'localhost',
        port: 8080
      });

      node = new Node({
        id: 'full-config-node',
        clusterId: 'production-cluster',
        service: 'auth-service',
        region: 'us-west-2',
        zone: 'us-west-2b',
        role: 'coordinator',
        tags: { 
          environment: 'production',
          tier: 'critical',
          datacenter: 'pdx-1'
        },
        transport,
        enableMetrics: true,
        enableChaos: false
      });
      
      expect(node.id).toBe('full-config-node');
      expect(node.metadata.nodeId).toBe('full-config-node');
      expect(node.metadata.clusterId).toBe('production-cluster');
      expect(node.metadata.service).toBe('auth-service');
      expect(node.metadata.region).toBe('us-west-2');
      expect(node.metadata.zone).toBe('us-west-2b');
      expect(node.metadata.pubKey).toBeDefined();
      expect(node.metadata.pubKey).not.toBe('temp-key'); // Should have real pubKey after cluster manager init
    });

    it('should have NodeMetadata with cryptographic public key after start', async () => {
      node = new Node({ 
        id: 'crypto-test-node',
        region: 'eu-central-1',
        zone: 'eu-central-1a',
        service: 'crypto-service'
      });

      await node.start();
      
      expect(node.metadata.pubKey).toBeDefined();
      expect(node.metadata.pubKey.length).toBeGreaterThan(100); // EC public key should be substantial
      expect(node.metadata.pubKey).toContain('-----BEGIN PUBLIC KEY-----');
      expect(node.metadata.pubKey).toContain('-----END PUBLIC KEY-----');
    });
  });

  describe('Quorum and Partition Detection Features', () => {
    it('should support zone-based quorum scenarios', async () => {
      const nodeA = new Node({
        id: 'quorum-node-a',
        clusterId: 'quorum-cluster',
        service: 'consensus-service',
        region: 'us-east-1',
        zone: 'us-east-1a'
      });

      const nodeB = new Node({
        id: 'quorum-node-b', 
        clusterId: 'quorum-cluster',
        service: 'consensus-service',
        region: 'us-east-1',
        zone: 'us-east-1b'
      });

      const nodeC = new Node({
        id: 'quorum-node-c',
        clusterId: 'quorum-cluster', 
        service: 'consensus-service',
        region: 'us-west-1',
        zone: 'us-west-1a'
      });

      // Same cluster, same service
      expect(nodeA.metadata.clusterId).toBe(nodeB.metadata.clusterId);
      expect(nodeA.metadata.service).toBe(nodeB.metadata.service);
      
      // Same region, different zones (good for zone-based quorum)
      expect(nodeA.metadata.region).toBe(nodeB.metadata.region);
      expect(nodeA.metadata.zone).not.toBe(nodeB.metadata.zone);
      
      // Different region (cross-region deployment)
      expect(nodeA.metadata.region).not.toBe(nodeC.metadata.region);

      // Cleanup
      await nodeA.stop();
      await nodeB.stop(); 
      await nodeC.stop();
    });

    it('should provide access control with unique public keys', async () => {
      const coordinatorNode = new Node({
        id: 'coordinator-1',
        clusterId: 'secure-cluster',
        service: 'coordinator-service',
        region: 'us-east-1',
        zone: 'us-east-1a',
        role: 'coordinator'
      });

      const workerNode = new Node({
        id: 'worker-1',
        clusterId: 'secure-cluster', 
        service: 'worker-service',
        region: 'us-east-1',
        zone: 'us-east-1b',
        role: 'worker'
      });

      try {
        await coordinatorNode.start();
        await workerNode.start();

        // Same cluster but different services and roles
        expect(coordinatorNode.metadata.clusterId).toBe(workerNode.metadata.clusterId);
        expect(coordinatorNode.metadata.service).not.toBe(workerNode.metadata.service);
        
        // Different public keys for access control
        expect(coordinatorNode.metadata.pubKey).not.toBe(workerNode.metadata.pubKey);
        expect(coordinatorNode.metadata.pubKey).toBeDefined();
        expect(workerNode.metadata.pubKey).toBeDefined();
      } finally {
        // Guaranteed cleanup even if test fails
        if (coordinatorNode.isRunning()) {
          await coordinatorNode.stop();
        }
        if (workerNode.isRunning()) {
          await workerNode.stop();
        }
      }
    });

    it('should track incarnation for failure detection', async () => {
      // In a real scenario, incarnation would increment when a node restarts
      // For now, we test that the field is accessible and consistent
      node = new Node({
        id: 'incarnation-test',
        clusterId: 'failure-detection-cluster',
        service: 'resilient-service',
        region: 'us-central-1',
        zone: 'us-central-1a'
      });

      expect(node.metadata.incarnation).toBe(0); // New node starts at incarnation 0
      expect(node.metadata.startTime).toBeGreaterThan(Date.now() - 1000); // Recent start time
    });
  });

  describe('Metadata Serialization and Network Transport', () => {
    it('should serialize NodeMetadata for network transport', async () => {
      node = new Node({
        id: 'serialization-test',
        clusterId: 'network-cluster',
        service: 'transport-service', 
        region: 'ap-southeast-1',
        zone: 'ap-southeast-1a',
        tags: { version: '2.0.0', env: 'staging' }
      });

      await node.start();

      const serialized = JSON.stringify(node.metadata);
      const deserialized = JSON.parse(serialized);

      expect(deserialized.nodeId).toBe('serialization-test');
      expect(deserialized.clusterId).toBe('network-cluster');
      expect(deserialized.service).toBe('transport-service');
      expect(deserialized.region).toBe('ap-southeast-1');
      expect(deserialized.zone).toBe('ap-southeast-1a');
      expect(deserialized.pubKey).toBeDefined();
      expect(deserialized.startTime).toBeDefined();
      expect(deserialized.incarnation).toBeDefined();
      expect(deserialized.version).toBeDefined();
    });

    it('should maintain metadata consistency across cluster operations', async () => {
      node = new Node({
        id: 'consistency-test',
        clusterId: 'consistent-cluster',
        service: 'consistent-service',
        region: 'eu-west-1', 
        zone: 'eu-west-1a'
      });

      await node.start();

      const nodeInfo = node.getNodeInfo();
      
      // Node info should reflect metadata values
      expect(nodeInfo.id).toBe(node.metadata.nodeId);
      
      const clusterMetadata = node.getClusterMetadata();
      expect(clusterMetadata).toBeDefined();
    });
  });
});
