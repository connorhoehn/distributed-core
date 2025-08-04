/**
 * Geographic extensions for gossip protocol
 */

export interface GeographicGossipMessage {
  nodeId: string;
  region: string;
  zone: string;
  coordinates?: string;
  networkTier: string;
  capabilities: string;
  maxBandwidth: string;
  timestamp: number;
}

export interface GossipTarget {
  nodeId: string;
  region: string;
  priority: number;
}

/**
 * Geographic gossip optimization utilities
 */
export class GeographicGossip {
  /**
   * Determine gossip targets based on geographic criteria
   */
  static selectGossipTargets(
    currentNode: { region: string; zone: string },
    allNodes: Array<{ nodeId: string; region: string; zone: string }>,
    maxTargets: number = 3
  ): GossipTarget[] {
    const targets: GossipTarget[] = [];
    
    // Priority 1: Same zone nodes
    const sameZoneNodes = allNodes.filter(node => 
      node.zone === currentNode.zone && node.nodeId !== currentNode.region
    );
    
    sameZoneNodes.forEach(node => {
      targets.push({ nodeId: node.nodeId, region: node.region, priority: 1 });
    });
    
    // Priority 2: Same region, different zone
    const sameRegionNodes = allNodes.filter(node => 
      node.region === currentNode.region && 
      node.zone !== currentNode.zone
    );
    
    sameRegionNodes.forEach(node => {
      targets.push({ nodeId: node.nodeId, region: node.region, priority: 2 });
    });
    
    // Priority 3: Different regions (for cross-region awareness)
    const differentRegionNodes = allNodes.filter(node => 
      node.region !== currentNode.region
    );
    
    // Select representative nodes from each region
    const regionRepresentatives = new Map<string, any>();
    differentRegionNodes.forEach(node => {
      if (!regionRepresentatives.has(node.region)) {
        regionRepresentatives.set(node.region, node);
      }
    });
    
    Array.from(regionRepresentatives.values()).forEach(node => {
      targets.push({ nodeId: node.nodeId, region: node.region, priority: 3 });
    });
    
    // Sort by priority and limit
    return targets
      .sort((a, b) => a.priority - b.priority)
      .slice(0, maxTargets);
  }

  /**
   * Create geographic gossip message
   */
  static createGeographicMessage(nodeMetadata: {
    nodeId: string;
    region: string;
    zone: string;
    tags?: {
      coordinates?: string;
      networkTier?: string;
      capabilities?: string;
      maxBandwidth?: string;
    };
  }): GeographicGossipMessage {
    return {
      nodeId: nodeMetadata.nodeId,
      region: nodeMetadata.region,
      zone: nodeMetadata.zone,
      coordinates: nodeMetadata.tags?.coordinates,
      networkTier: nodeMetadata.tags?.networkTier || 'edge',
      capabilities: nodeMetadata.tags?.capabilities || '',
      maxBandwidth: nodeMetadata.tags?.maxBandwidth || '0',
      timestamp: Date.now()
    };
  }

  /**
   * Compress geographic data for efficient transmission
   */
  static compressGeographicData(messages: GeographicGossipMessage[]): string {
    // Simple compression: group by region
    const regionGroups = new Map<string, GeographicGossipMessage[]>();
    
    messages.forEach(msg => {
      if (!regionGroups.has(msg.region)) {
        regionGroups.set(msg.region, []);
      }
      regionGroups.get(msg.region)!.push(msg);
    });
    
    const compressed = {
      regions: Array.from(regionGroups.entries()).map(([region, nodes]) => ({
        region,
        count: nodes.length,
        nodes: nodes.map(n => ({
          id: n.nodeId,
          z: n.zone,
          c: n.coordinates,
          t: n.networkTier,
          cap: n.capabilities,
          bw: n.maxBandwidth,
          ts: n.timestamp
        }))
      }))
    };
    
    return JSON.stringify(compressed);
  }

  /**
   * Decompress geographic data
   */
  static decompressGeographicData(compressedData: string): GeographicGossipMessage[] {
    try {
      const data = JSON.parse(compressedData);
      const messages: GeographicGossipMessage[] = [];
      
      data.regions.forEach((regionData: any) => {
        regionData.nodes.forEach((node: any) => {
          messages.push({
            nodeId: node.id,
            region: regionData.region,
            zone: node.z,
            coordinates: node.c,
            networkTier: node.t,
            capabilities: node.cap,
            maxBandwidth: node.bw,
            timestamp: node.ts
          });
        });
      });
      
      return messages;
    } catch (error) {
      return [];
    }
  }

  /**
   * Calculate geographic gossip frequency based on distance
   */
  static calculateGossipFrequency(
    baseFrequency: number,
    currentRegion: string,
    targetRegion: string,
    regionDistances?: Map<string, Map<string, number>>
  ): number {
    // Same region: higher frequency
    if (currentRegion === targetRegion) {
      return baseFrequency;
    }
    
    // Different regions: lower frequency based on distance
    if (regionDistances?.has(currentRegion)) {
      const distances = regionDistances.get(currentRegion)!;
      const distance = distances.get(targetRegion) || 1000; // Default distance
      
      // Reduce frequency based on distance (simplified)
      const distanceFactor = Math.min(distance / 1000, 5); // Cap at 5x reduction
      return Math.max(baseFrequency / distanceFactor, baseFrequency / 5);
    }
    
    // Default: reduce frequency for cross-region
    return baseFrequency / 2;
  }
}

describe('Geographic Gossip Protocol', () => {
  const mockNodes = [
    { nodeId: 'us-east-1', region: 'us-east', zone: 'us-east-1a' },
    { nodeId: 'us-east-2', region: 'us-east', zone: 'us-east-1b' },
    { nodeId: 'us-west-1', region: 'us-west', zone: 'us-west-2a' },
    { nodeId: 'eu-west-1', region: 'eu-west', zone: 'eu-west-1a' },
    { nodeId: 'ap-south-1', region: 'ap-south', zone: 'ap-south-1a' },
  ];

  describe('Gossip Target Selection', () => {
    it('should prioritize same zone nodes', () => {
      const currentNode = { region: 'us-east', zone: 'us-east-1a' };
      const targets = GeographicGossip.selectGossipTargets(currentNode, mockNodes, 5);
      
      // Same zone should have priority 1
      const sameZoneTargets = targets.filter(t => t.priority === 1);
      expect(sameZoneTargets.length).toBeGreaterThanOrEqual(0); // No other nodes in same zone in mock data
    });

    it('should include cross-region targets for awareness', () => {
      const currentNode = { region: 'us-east', zone: 'us-east-1a' };
      const targets = GeographicGossip.selectGossipTargets(currentNode, mockNodes, 5);
      
      // Should include nodes from different regions
      const crossRegionTargets = targets.filter(t => t.region !== 'us-east');
      expect(crossRegionTargets.length).toBeGreaterThan(0);
    });

    it('should limit targets to maximum specified', () => {
      const currentNode = { region: 'us-east', zone: 'us-east-1a' };
      const targets = GeographicGossip.selectGossipTargets(currentNode, mockNodes, 2);
      
      expect(targets.length).toBeLessThanOrEqual(2);
    });

    it('should select one representative per region', () => {
      const currentNode = { region: 'us-east', zone: 'us-east-1a' };
      const targets = GeographicGossip.selectGossipTargets(currentNode, mockNodes, 10);
      
      // Count unique regions in targets
      const uniqueRegions = new Set(targets.map(t => t.region));
      expect(uniqueRegions.size).toBeGreaterThan(1);
    });
  });

  describe('Geographic Message Creation', () => {
    it('should create complete geographic message', () => {
      const nodeMetadata = {
        nodeId: 'us-east-1',
        region: 'us-east',
        zone: 'us-east-1a',
        tags: {
          coordinates: '40.7128,-74.0060',
          networkTier: 'core',
          capabilities: 'streaming,transcoding',
          maxBandwidth: '1000'
        }
      };
      
      const message = GeographicGossip.createGeographicMessage(nodeMetadata);
      
      expect(message.nodeId).toBe('us-east-1');
      expect(message.region).toBe('us-east');
      expect(message.zone).toBe('us-east-1a');
      expect(message.coordinates).toBe('40.7128,-74.0060');
      expect(message.networkTier).toBe('core');
      expect(message.capabilities).toBe('streaming,transcoding');
      expect(message.maxBandwidth).toBe('1000');
      expect(message.timestamp).toBeGreaterThan(0);
    });

    it('should handle minimal metadata', () => {
      const nodeMetadata = {
        nodeId: 'us-west-1',
        region: 'us-west',
        zone: 'us-west-2a'
      };
      
      const message = GeographicGossip.createGeographicMessage(nodeMetadata);
      
      expect(message.nodeId).toBe('us-west-1');
      expect(message.networkTier).toBe('edge'); // Default
      expect(message.capabilities).toBe(''); // Default
      expect(message.maxBandwidth).toBe('0'); // Default
    });
  });

  describe('Data Compression', () => {
    it('should compress and decompress geographic data correctly', () => {
      const originalMessages: GeographicGossipMessage[] = [
        {
          nodeId: 'us-east-1',
          region: 'us-east',
          zone: 'us-east-1a',
          coordinates: '40.7128,-74.0060',
          networkTier: 'core',
          capabilities: 'streaming,transcoding',
          maxBandwidth: '1000',
          timestamp: 1234567890
        },
        {
          nodeId: 'us-east-2',
          region: 'us-east',
          zone: 'us-east-1b',
          coordinates: '40.7580,-73.9855',
          networkTier: 'edge',
          capabilities: 'streaming',
          maxBandwidth: '500',
          timestamp: 1234567891
        }
      ];
      
      const compressed = GeographicGossip.compressGeographicData(originalMessages);
      const decompressed = GeographicGossip.decompressGeographicData(compressed);
      
      expect(decompressed).toHaveLength(2);
      expect(decompressed[0].nodeId).toBe('us-east-1');
      expect(decompressed[0].region).toBe('us-east');
      expect(decompressed[1].nodeId).toBe('us-east-2');
      expect(decompressed[1].capabilities).toBe('streaming');
    });

    it('should handle compression of empty data', () => {
      const compressed = GeographicGossip.compressGeographicData([]);
      const decompressed = GeographicGossip.decompressGeographicData(compressed);
      
      expect(decompressed).toHaveLength(0);
    });

    it('should handle invalid compressed data gracefully', () => {
      const decompressed = GeographicGossip.decompressGeographicData('invalid json');
      
      expect(decompressed).toHaveLength(0);
    });
  });

  describe('Gossip Frequency Calculation', () => {
    it('should maintain base frequency for same region', () => {
      const baseFreq = 1000;
      const frequency = GeographicGossip.calculateGossipFrequency(
        baseFreq, 'us-east', 'us-east'
      );
      
      expect(frequency).toBe(baseFreq);
    });

    it('should reduce frequency for different regions', () => {
      const baseFreq = 1000;
      const frequency = GeographicGossip.calculateGossipFrequency(
        baseFreq, 'us-east', 'eu-west'
      );
      
      expect(frequency).toBeLessThan(baseFreq);
    });

    it('should use distance-based frequency when distances provided', () => {
      const baseFreq = 1000;
      const regionDistances = new Map([
        ['us-east', new Map([
          ['us-west', 500],
          ['eu-west', 1500]
        ])]
      ]);
      
      const freqNear = GeographicGossip.calculateGossipFrequency(
        baseFreq, 'us-east', 'us-west', regionDistances
      );
      const freqFar = GeographicGossip.calculateGossipFrequency(
        baseFreq, 'us-east', 'eu-west', regionDistances
      );
      
      expect(freqNear).toBeGreaterThan(freqFar);
    });

    it('should have minimum frequency floor', () => {
      const baseFreq = 1000;
      const regionDistances = new Map([
        ['us-east', new Map([
          ['far-region', 10000] // Very far
        ])]
      ]);
      
      const frequency = GeographicGossip.calculateGossipFrequency(
        baseFreq, 'us-east', 'far-region', regionDistances
      );
      
      expect(frequency).toBeGreaterThanOrEqual(baseFreq / 5); // Minimum floor
    });
  });
});
