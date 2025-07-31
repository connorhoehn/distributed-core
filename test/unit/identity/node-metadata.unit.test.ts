import { NodeMetadata } from '../../../src/identity/NodeMetadata';

describe('NodeMetadata Unit Tests', () => {
  describe('Constructor and Properties', () => {
    it('should create NodeMetadata with all required fields', () => {
      const metadata = new NodeMetadata(
        'node-1',
        'cluster-1', 
        'distributed-core',
        'us-east-1a',
        'us-east-1',
        'pubkey-123'
      );

      expect(metadata.nodeId).toBe('node-1');
      expect(metadata.clusterId).toBe('cluster-1');
      expect(metadata.service).toBe('distributed-core');
      expect(metadata.zone).toBe('us-east-1a');
      expect(metadata.region).toBe('us-east-1');
      expect(metadata.pubKey).toBe('pubkey-123');
      expect(metadata.startTime).toBeGreaterThan(0);
      expect(metadata.incarnation).toBe(0);
      expect(metadata.version).toBe('v1.0.0');
    });

    it('should create NodeMetadata with custom optional values', () => {
      const customStartTime = Date.now() - 1000;
      const metadata = new NodeMetadata(
        'node-2',
        'cluster-2',
        'auth-service', 
        'us-west-2b',
        'us-west-2',
        'pubkey-456',
        customStartTime,
        5,
        'v2.1.0'
      );

      expect(metadata.nodeId).toBe('node-2');
      expect(metadata.clusterId).toBe('cluster-2');
      expect(metadata.service).toBe('auth-service');
      expect(metadata.zone).toBe('us-west-2b');
      expect(metadata.region).toBe('us-west-2');
      expect(metadata.pubKey).toBe('pubkey-456');
      expect(metadata.startTime).toBe(customStartTime);
      expect(metadata.incarnation).toBe(5);
      expect(metadata.version).toBe('v2.1.0');
    });

    it('should have readonly properties', () => {
      const metadata = new NodeMetadata(
        'node-3',
        'cluster-3',
        'data-service',
        'eu-central-1a', 
        'eu-central-1',
        'pubkey-789'
      );

      // These should be readonly - TypeScript will catch attempts to modify
      expect(metadata.nodeId).toBe('node-3');
      expect(metadata.clusterId).toBe('cluster-3');
      expect(metadata.service).toBe('data-service');
    });
  });

  describe('Quorum and Partition Detection Support', () => {
    it('should support zone-based quorum detection', () => {
      const nodeA = new NodeMetadata('node-a', 'cluster-1', 'service', 'us-east-1a', 'us-east-1', 'key-a');
      const nodeB = new NodeMetadata('node-b', 'cluster-1', 'service', 'us-east-1b', 'us-east-1', 'key-b');
      const nodeC = new NodeMetadata('node-c', 'cluster-1', 'service', 'us-west-1a', 'us-west-1', 'key-c');

      // Same region, different zones
      expect(nodeA.region).toBe(nodeB.region);
      expect(nodeA.zone).not.toBe(nodeB.zone);

      // Different regions
      expect(nodeA.region).not.toBe(nodeC.region);
    });

    it('should support access control policies with pubKey', () => {
      const coordinatorNode = new NodeMetadata(
        'coordinator-1',
        'secure-cluster',
        'coordinator-service',
        'us-east-1a',
        'us-east-1', 
        'coordinator-pubkey-123'
      );

      const workerNode = new NodeMetadata(
        'worker-1',
        'secure-cluster',
        'worker-service',
        'us-east-1b',
        'us-east-1',
        'worker-pubkey-456'
      );

      // Both nodes in same cluster but different services and keys
      expect(coordinatorNode.clusterId).toBe(workerNode.clusterId);
      expect(coordinatorNode.service).not.toBe(workerNode.service);
      expect(coordinatorNode.pubKey).not.toBe(workerNode.pubKey);
    });

    it('should track node incarnation for failure detection', () => {
      const nodeV1 = new NodeMetadata('node-1', 'cluster-1', 'service', 'zone-a', 'region-1', 'key-1', Date.now(), 0);
      const nodeV2 = new NodeMetadata('node-1', 'cluster-1', 'service', 'zone-a', 'region-1', 'key-1', Date.now(), 1);

      expect(nodeV1.nodeId).toBe(nodeV2.nodeId);
      expect(nodeV1.incarnation).toBe(0);
      expect(nodeV2.incarnation).toBe(1);
      expect(nodeV2.incarnation).toBeGreaterThan(nodeV1.incarnation);
    });
  });

  describe('Metadata Serialization', () => {
    it('should be serializable to JSON', () => {
      const metadata = new NodeMetadata(
        'node-json',
        'cluster-json',
        'test-service',
        'us-east-1a',
        'us-east-1',
        'json-pubkey'
      );

      const json = JSON.stringify(metadata);
      const parsed = JSON.parse(json);

      expect(parsed.nodeId).toBe('node-json');
      expect(parsed.clusterId).toBe('cluster-json');
      expect(parsed.service).toBe('test-service');
      expect(parsed.zone).toBe('us-east-1a');
      expect(parsed.region).toBe('us-east-1');
      expect(parsed.pubKey).toBe('json-pubkey');
      expect(parsed.startTime).toBeDefined();
      expect(parsed.incarnation).toBeDefined();
      expect(parsed.version).toBeDefined();
    });

    it('should maintain data integrity across serialization', () => {
      const original = new NodeMetadata(
        'integrity-test',
        'test-cluster',
        'integrity-service',
        'zone-test',
        'region-test',
        'integrity-key',
        1640995200000, // Fixed timestamp
        3,
        'v1.2.3'
      );

      const json = JSON.stringify(original);
      const restored = JSON.parse(json);

      expect(restored.nodeId).toBe(original.nodeId);
      expect(restored.clusterId).toBe(original.clusterId);
      expect(restored.service).toBe(original.service);
      expect(restored.zone).toBe(original.zone);
      expect(restored.region).toBe(original.region);
      expect(restored.pubKey).toBe(original.pubKey);
      expect(restored.startTime).toBe(original.startTime);
      expect(restored.incarnation).toBe(original.incarnation);
      expect(restored.version).toBe(original.version);
    });
  });
});
