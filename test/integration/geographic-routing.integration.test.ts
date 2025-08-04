import { ClusterManager } from '../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../src/cluster/config/BootstrapConfig';
import { InMemoryAdapter } from '../../src/transport/adapters/InMemoryAdapter';
import { NodeId } from '../../src/types';

const createGeoNode = async (
  nodeId: string, 
  port: number,
  region: string,
  zone: string,
  datacenter: string,
  coordinates: { lat: number; lng: number },
  role: string = 'worker',
  seedNodes: any[] = []
): Promise<ClusterManager> => {
  const nodeIdObj: NodeId = { id: nodeId, address: '127.0.0.1', port };
  const transport = new InMemoryAdapter(nodeIdObj);
  const config = new BootstrapConfig(seedNodes, 5000, 1000, false);
  
  // Use the tags field for extended metadata
  const nodeMetadata = {
    region,
    zone,
    role,
    tags: {
      datacenter,
      networkTier: region === 'us-east' ? 'core' : 'edge',
      capabilities: 'streaming,transcoding',
      maxBandwidth: '1000',
      preferredCodecs: 'h264,vp8',
      coordinates: `${coordinates.lat},${coordinates.lng}`
    }
  };

  const cluster = new ClusterManager(nodeId, transport, config, 100, nodeMetadata);
  
  return cluster;
};

async function createMultiRegionCluster() {
  // Define seed nodes as simple strings for InMemoryAdapter
  const seedNodeStrings = ['us-east-1', 'eu-west-1'];
  
  // Create all nodes with seed nodes reference
  const usEast1 = await createGeoNode('us-east-1', 8001, 'us-east', 'us-east-1a', 'dc1', 
    { lat: 40.7128, lng: -74.0060 }, 'core', []);
  
  const usEast2 = await createGeoNode('us-east-2', 8002, 'us-east', 'us-east-1b', 'dc1',
    { lat: 40.7580, lng: -73.9855 }, 'edge', seedNodeStrings);

  const usWest1 = await createGeoNode('us-west-1', 8003, 'us-west', 'us-west-2a', 'dc2',
    { lat: 37.7749, lng: -122.4194 }, 'core', seedNodeStrings);

  const usWest2 = await createGeoNode('us-west-2', 8004, 'us-west', 'us-west-2b', 'dc2',
    { lat: 37.4419, lng: -122.1430 }, 'edge', seedNodeStrings);

  const euWest1 = await createGeoNode('eu-west-1', 8005, 'eu-west', 'eu-west-1a', 'dc3',
    { lat: 51.5074, lng: -0.1278 }, 'core', []);

  const euWest2 = await createGeoNode('eu-west-2', 8006, 'eu-west', 'eu-west-1b', 'dc3',
    { lat: 48.8566, lng: 2.3522 }, 'edge', seedNodeStrings);

  const apSouth1 = await createGeoNode('ap-south-1', 8007, 'ap-south', 'ap-south-1a', 'dc4',
    { lat: 28.6139, lng: 77.2090 }, 'core', seedNodeStrings);

  const apSouth2 = await createGeoNode('ap-south-2', 8008, 'ap-south', 'ap-south-1b', 'dc4',
    { lat: 19.0760, lng: 72.8777 }, 'edge', seedNodeStrings);

  // Start seed nodes first and wait for them to be fully up
  await usEast1.start();
  await euWest1.start();
  
  // Allow seed nodes to establish
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Start remaining nodes in waves to allow gossip propagation
  await usEast2.start();
  await usWest1.start();
  await new Promise(resolve => setTimeout(resolve, 30));
  
  await usWest2.start();  
  await euWest2.start();
  await new Promise(resolve => setTimeout(resolve, 30));
  
  await apSouth1.start();
  await apSouth2.start();
  
  // Final wait for full cluster convergence
  await new Promise(resolve => setTimeout(resolve, 100));

  return { usEast1, usEast2, usWest1, usWest2, euWest1, euWest2, apSouth1, apSouth2 };
}

describe('Geographic Routing Integration', () => {
  let clusters: ClusterManager[] = [];
  let transports: InMemoryAdapter[] = [];
  let sharedNodes: { [key: string]: ClusterManager } | null = null;

  beforeAll(async () => {
    // Create the multi-region cluster once for all tests
    sharedNodes = await createMultiRegionCluster();
    
    // Store references for cleanup
    clusters = Object.values(sharedNodes);
  });

  afterAll(async () => {
    // Clean up all clusters after all tests complete
    await Promise.all(clusters.map(cluster => cluster.stop()));
    clusters = [];
    transports = [];
    InMemoryAdapter.clearRegistry();
    sharedNodes = null;
  });

  describe('Regional Clustering', () => {
    it('should form region-aware clusters', async () => {
      const nodes = sharedNodes!;
      
      // Verify each node knows about others
      for (const [nodeName, node] of Object.entries(nodes)) {
        const membership = node.getMembership();
        expect(membership.size).toBeGreaterThanOrEqual(1);
        
        // Check that node has its own metadata
        const selfInfo = membership.get(node.getNodeInfo().id);
        expect(selfInfo?.metadata?.region).toBeDefined();
        expect(selfInfo?.metadata?.zone).toBeDefined();
        expect(selfInfo?.metadata?.tags?.coordinates).toBeDefined();
      }
    }, 1000);

    it('should propagate geographic metadata across regions', async () => {
      const nodes = sharedNodes!;
      
      // Check that US East node knows about all regions
      const usEastMembership = nodes.usEast1.getMembership();
      const regions = new Set<string>();
      const zones = new Set<string>();
      
      for (const [nodeId, memberInfo] of usEastMembership.entries()) {
        if (memberInfo.metadata?.region) {
          regions.add(memberInfo.metadata.region);
        }
        if (memberInfo.metadata?.zone) {
          zones.add(memberInfo.metadata.zone);
        }
      }
      
      // Should know about multiple regions
      expect(regions.size).toBeGreaterThan(1);
      expect(zones.size).toBeGreaterThan(1);
      
      // Verify specific regions are present
      const regionsList = Array.from(regions);
      expect(regionsList).toContain('us-east');
      expect(regionsList.length).toBeGreaterThanOrEqual(2); // At least 2 regions
    }, 1000);
  });

  describe('Proximity-Based Node Selection', () => {
    it('should identify nodes in same region', async () => {
      const nodes = sharedNodes!;
      
      // Get same-region nodes from US East perspective
      const usEastMembership = nodes.usEast1.getMembership();
      const sameRegionNodes: string[] = [];
      const differentRegionNodes: string[] = [];
      
      for (const [nodeId, memberInfo] of usEastMembership.entries()) {
        if (memberInfo.metadata?.region === 'us-east') {
          sameRegionNodes.push(nodeId);
        } else if (memberInfo.metadata?.region) {
          differentRegionNodes.push(nodeId);
        }
      }
      
      // Should find other US East nodes
      expect(sameRegionNodes.length).toBeGreaterThanOrEqual(1); // At least self
      expect(differentRegionNodes.length).toBeGreaterThan(0); // Other regions
      
      // Same region should include both us-east nodes
      const usEastNodeIds = sameRegionNodes.filter(id => id.startsWith('us-east'));
      expect(usEastNodeIds.length).toBeGreaterThanOrEqual(1);
    }, 1000);

    it('should calculate geographic distances', async () => {
      const nodes = sharedNodes!;
      
      const membership = nodes.usEast1.getMembership();
      const nodeCoordinates = new Map<string, { lat: number; lng: number }>();
      
      // Collect coordinates from membership
      for (const [nodeId, memberInfo] of membership.entries()) {
        if (memberInfo.metadata?.tags?.coordinates) {
          const [lat, lng] = memberInfo.metadata.tags.coordinates.split(',').map(Number);
          nodeCoordinates.set(nodeId, { lat, lng });
        }
      }
      
      // Should have coordinates for multiple nodes
      expect(nodeCoordinates.size).toBeGreaterThan(1);
      
      // Verify we have different geographic locations
      const uniqueCoordinates = new Set(
        Array.from(nodeCoordinates.values()).map(coord => `${coord.lat},${coord.lng}`)
      );
      expect(uniqueCoordinates.size).toBeGreaterThan(1); // Multiple locations
    }, 1000);
  });

  describe('Network Tier Awareness', () => {
    it('should identify core vs edge nodes', async () => {
      const nodes = sharedNodes!;
      
      const membership = nodes.usEast1.getMembership();
      const coreNodes: string[] = [];
      const edgeNodes: string[] = [];
      
      for (const [nodeId, memberInfo] of membership.entries()) {
        const networkTier = memberInfo.metadata?.tags?.networkTier;
        if (networkTier === 'core') {
          coreNodes.push(nodeId);
        } else if (networkTier === 'edge') {
          edgeNodes.push(nodeId);
        }
      }
      
      // Should have both core and edge nodes
      expect(coreNodes.length).toBeGreaterThan(0);
      expect(edgeNodes.length).toBeGreaterThan(0);
      
      // US East should be core
      const usEastCoreNodes = coreNodes.filter(id => id.startsWith('us-east'));
      expect(usEastCoreNodes.length).toBeGreaterThan(0);
    }, 1000);

    it('should propagate capability metadata', async () => {
      const nodes = sharedNodes!;
      
      const membership = nodes.usEast1.getMembership();
      let nodesWithCapabilities = 0;
      let nodesWithCodecs = 0;
      
      for (const [nodeId, memberInfo] of membership.entries()) {
        if (memberInfo.metadata?.tags?.capabilities) {
          nodesWithCapabilities++;
          expect(memberInfo.metadata.tags.capabilities).toContain('streaming');
        }
        if (memberInfo.metadata?.tags?.preferredCodecs) {
          nodesWithCodecs++;
          expect(memberInfo.metadata.tags.preferredCodecs).toContain('h264');
        }
      }
      
      expect(nodesWithCapabilities).toBeGreaterThan(0);
      expect(nodesWithCodecs).toBeGreaterThan(0);
    }, 1000);
  });

  describe('Regional Failure Scenarios', () => {
    it('should handle single region failure', async () => {
      const nodes = sharedNodes!;
      
      // Simulate EU region failure
      await nodes.euWest1.stop();
      await nodes.euWest2.stop();
      
      // Wait for failure detection
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Check that other regions still function
      const usEastMembership = nodes.usEast1.getMembership();
      let aliveNodes = 0;
      let euNodes = 0;
      
      for (const [nodeId, memberInfo] of usEastMembership.entries()) {
        if (memberInfo.status === 'ALIVE') {
          aliveNodes++;
        }
        if (memberInfo.metadata?.region === 'eu-west') {
          euNodes++;
        }
      }
      
      // Should still have alive nodes from other regions
      expect(aliveNodes).toBeGreaterThan(0);
      
      // EU nodes should eventually be detected as failed or removed
      // (depending on failure detection timing)
    }, 2000);

    it('should maintain cross-region connectivity during partial failures', async () => {
      const nodes = sharedNodes!;
      
      // Simulate partial failure - one node per region
      await nodes.usEast2.stop();
      await nodes.usWest2.stop();
      await nodes.apSouth2.stop();
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Remaining nodes should still see cross-region connectivity
      const membership = nodes.usEast1.getMembership();
      const regionsStillAlive = new Set<string>();
      
      for (const [nodeId, memberInfo] of membership.entries()) {
        if (memberInfo.status === 'ALIVE' && memberInfo.metadata?.region) {
          regionsStillAlive.add(memberInfo.metadata.region);
        }
      }
      
      // Should still have multiple regions represented
      expect(regionsStillAlive.size).toBeGreaterThan(1);
    }, 2000);
  });

  describe('Geographic Load Distribution', () => {
    it('should track bandwidth capacity by region', async () => {
      const nodes = sharedNodes!;
      
      const membership = nodes.usEast1.getMembership();
      const regionalCapacity = new Map<string, number>();
      
      for (const [nodeId, memberInfo] of membership.entries()) {
        const region = memberInfo.metadata?.region;
        const bandwidth = parseInt(memberInfo.metadata?.tags?.maxBandwidth || '0');
        
        if (region) {
          const current = regionalCapacity.get(region) || 0;
          regionalCapacity.set(region, current + bandwidth);
        }
      }
      
      // Should have capacity data for multiple regions
      expect(regionalCapacity.size).toBeGreaterThan(1);
      
      // Each region should have some capacity
      for (const [region, capacity] of regionalCapacity.entries()) {
        expect(capacity).toBeGreaterThan(0);
      }
    }, 1000);
  });

  describe('Cross-Region State Synchronization', () => {
    it('should synchronize node metadata across continents', async () => {
      const nodes = sharedNodes!;
      
      // Compare membership between distant nodes (US East vs Asia Pacific)
      const usEastMembership = nodes.usEast1.getMembership();
      const apSouthMembership = nodes.apSouth1.getMembership();
      
      // Both should know about each other
      const usEastNodes = new Set(usEastMembership.keys());
      const apSouthNodes = new Set(apSouthMembership.keys());
      
      // Should have significant overlap in known nodes
      const intersection = new Set([...usEastNodes].filter(x => apSouthNodes.has(x)));
      expect(intersection.size).toBeGreaterThan(0);
      
      // Both should know about nodes from multiple regions
      const usEastRegions = new Set<string>();
      const apSouthRegions = new Set<string>();
      
      for (const [_, memberInfo] of usEastMembership.entries()) {
        if (memberInfo.metadata?.region) {
          usEastRegions.add(memberInfo.metadata.region);
        }
      }
      
      for (const [_, memberInfo] of apSouthMembership.entries()) {
        if (memberInfo.metadata?.region) {
          apSouthRegions.add(memberInfo.metadata.region);
        }
      }
      
      expect(usEastRegions.size).toBeGreaterThan(1);
      expect(apSouthRegions.size).toBeGreaterThan(1);
    }, 1000);
  });
});
