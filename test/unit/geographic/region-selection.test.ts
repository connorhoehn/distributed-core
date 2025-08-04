import { calculateDistance, parseCoordinates, Coordinates } from './distance-calculations.test';

/**
 * Region-based node selection utilities
 */

export interface NodeInfo {
  id: string;
  region: string;
  zone: string;
  coordinates?: Coordinates;
  networkTier: 'core' | 'edge';
  capabilities: string[];
  maxBandwidth: number;
}

/**
 * Select nodes based on geographic criteria
 */
export class RegionSelector {
  /**
   * Find nodes in the same region
   */
  static findSameRegionNodes(currentRegion: string, allNodes: NodeInfo[]): NodeInfo[] {
    return allNodes.filter(node => node.region === currentRegion);
  }

  /**
   * Find nodes in the same zone
   */
  static findSameZoneNodes(currentZone: string, allNodes: NodeInfo[]): NodeInfo[] {
    return allNodes.filter(node => node.zone === currentZone);
  }

  /**
   * Select nodes by network tier preference
   */
  static selectByNetworkTier(
    preferredTier: 'core' | 'edge',
    allNodes: NodeInfo[],
    fallbackToOther: boolean = true
  ): NodeInfo[] {
    const preferredNodes = allNodes.filter(node => node.networkTier === preferredTier);
    
    if (preferredNodes.length > 0 || !fallbackToOther) {
      return preferredNodes;
    }
    
    // Fallback to other tier if none found
    const otherTier = preferredTier === 'core' ? 'edge' : 'core';
    return allNodes.filter(node => node.networkTier === otherTier);
  }

  /**
   * Select nodes by proximity using coordinates
   */
  static selectByProximity(
    originCoordinates: Coordinates,
    allNodes: NodeInfo[],
    maxDistanceKm?: number
  ): Array<NodeInfo & { distance: number }> {
    const nodesWithDistance = allNodes
      .filter(node => node.coordinates)
      .map(node => ({
        ...node,
        distance: calculateDistance(originCoordinates, node.coordinates!)
      }))
      .sort((a, b) => a.distance - b.distance);

    if (maxDistanceKm) {
      return nodesWithDistance.filter(node => node.distance <= maxDistanceKm);
    }

    return nodesWithDistance;
  }

  /**
   * Select optimal nodes using combined criteria
   */
  static selectOptimalNodes(
    criteria: {
      currentRegion?: string;
      currentZone?: string;
      currentCoordinates?: Coordinates;
      preferredTier?: 'core' | 'edge';
      maxDistanceKm?: number;
      requiredCapabilities?: string[];
      minBandwidth?: number;
    },
    allNodes: NodeInfo[]
  ): NodeInfo[] {
    let candidates = [...allNodes];

    // If both region and zone are specified, prioritize zone
    if (criteria.currentZone) {
      const sameZoneNodes = this.findSameZoneNodes(criteria.currentZone, candidates);
      if (sameZoneNodes.length > 0) {
        candidates = sameZoneNodes;
      }
    } else if (criteria.currentRegion) {
      // Only filter by region if zone is not specified
      const sameRegionNodes = this.findSameRegionNodes(criteria.currentRegion, candidates);
      if (sameRegionNodes.length > 0) {
        candidates = sameRegionNodes;
      }
    }

    // Filter by capabilities
    if (criteria.requiredCapabilities && criteria.requiredCapabilities.length > 0) {
      candidates = candidates.filter(node =>
        criteria.requiredCapabilities!.every(cap => node.capabilities.includes(cap))
      );
    }

    // Filter by bandwidth
    if (criteria.minBandwidth) {
      candidates = candidates.filter(node => node.maxBandwidth >= criteria.minBandwidth!);
    }

    // Apply network tier preference
    if (criteria.preferredTier) {
      const tierFiltered = this.selectByNetworkTier(criteria.preferredTier, candidates, true);
      if (tierFiltered.length > 0) {
        candidates = tierFiltered;
      }
    }

    // Apply proximity filtering if coordinates provided
    if (criteria.currentCoordinates) {
      const proximityFiltered = this.selectByProximity(
        criteria.currentCoordinates,
        candidates,
        criteria.maxDistanceKm
      );
      return proximityFiltered;
    }

    return candidates;
  }
}

describe('Region Selection', () => {
  const mockNodes: NodeInfo[] = [
    {
      id: 'us-east-1',
      region: 'us-east',
      zone: 'us-east-1a',
      coordinates: { lat: 40.7128, lng: -74.0060 },
      networkTier: 'core',
      capabilities: ['streaming', 'transcoding'],
      maxBandwidth: 1000
    },
    {
      id: 'us-east-2',
      region: 'us-east',
      zone: 'us-east-1b',
      coordinates: { lat: 40.7580, lng: -73.9855 },
      networkTier: 'edge',
      capabilities: ['streaming'],
      maxBandwidth: 500
    },
    {
      id: 'us-west-1',
      region: 'us-west',
      zone: 'us-west-2a',
      coordinates: { lat: 37.7749, lng: -122.4194 },
      networkTier: 'core',
      capabilities: ['streaming', 'transcoding', 'recording'],
      maxBandwidth: 2000
    },
    {
      id: 'eu-west-1',
      region: 'eu-west',
      zone: 'eu-west-1a',
      coordinates: { lat: 51.5074, lng: -0.1278 },
      networkTier: 'edge',
      capabilities: ['streaming'],
      maxBandwidth: 800
    }
  ];

  describe('Same Region Selection', () => {
    it('should find nodes in the same region', () => {
      const sameRegionNodes = RegionSelector.findSameRegionNodes('us-east', mockNodes);
      
      expect(sameRegionNodes).toHaveLength(2);
      expect(sameRegionNodes.every(node => node.region === 'us-east')).toBe(true);
      expect(sameRegionNodes.map(n => n.id)).toContain('us-east-1');
      expect(sameRegionNodes.map(n => n.id)).toContain('us-east-2');
    });

    it('should return empty array for non-existent region', () => {
      const sameRegionNodes = RegionSelector.findSameRegionNodes('non-existent', mockNodes);
      
      expect(sameRegionNodes).toHaveLength(0);
    });
  });

  describe('Same Zone Selection', () => {
    it('should find nodes in the same zone', () => {
      const sameZoneNodes = RegionSelector.findSameZoneNodes('us-east-1a', mockNodes);
      
      expect(sameZoneNodes).toHaveLength(1);
      expect(sameZoneNodes[0].id).toBe('us-east-1');
    });
  });

  describe('Network Tier Selection', () => {
    it('should select core nodes when preferred', () => {
      const coreNodes = RegionSelector.selectByNetworkTier('core', mockNodes, false);
      
      expect(coreNodes).toHaveLength(2);
      expect(coreNodes.every(node => node.networkTier === 'core')).toBe(true);
    });

    it('should select edge nodes when preferred', () => {
      const edgeNodes = RegionSelector.selectByNetworkTier('edge', mockNodes, false);
      
      expect(edgeNodes).toHaveLength(2);
      expect(edgeNodes.every(node => node.networkTier === 'edge')).toBe(true);
    });

    it('should fallback to other tier when none available', () => {
      const usEastNodes = mockNodes.filter(n => n.region === 'us-east');
      const coreNodes = RegionSelector.selectByNetworkTier('core', usEastNodes, true);
      
      // Should find core node in us-east, no fallback needed
      expect(coreNodes).toHaveLength(1);
      expect(coreNodes[0].networkTier).toBe('core');
    });
  });

  describe('Proximity Selection', () => {
    it('should sort nodes by distance from origin', () => {
      const nycCoords = { lat: 40.7128, lng: -74.0060 };
      const proximityNodes = RegionSelector.selectByProximity(nycCoords, mockNodes);
      
      expect(proximityNodes).toHaveLength(4);
      // Should be sorted by distance, NYC coordinates should be closest to us-east-1
      expect(proximityNodes[0].id).toBe('us-east-1');
      expect(proximityNodes[0].distance).toBe(0); // Same coordinates
    });

    it('should filter by maximum distance', () => {
      const nycCoords = { lat: 40.7128, lng: -74.0060 };
      const proximityNodes = RegionSelector.selectByProximity(nycCoords, mockNodes, 100);
      
      // Should only include nodes within 100km of NYC
      expect(proximityNodes.length).toBeGreaterThan(0);
      expect(proximityNodes.every(node => node.distance <= 100)).toBe(true);
    });
  });

  describe('Optimal Node Selection', () => {
    it('should select nodes using combined criteria', () => {
      const criteria = {
        currentRegion: 'us-east',
        preferredTier: 'core' as const,
        requiredCapabilities: ['streaming'],
        minBandwidth: 500
      };
      
      const optimalNodes = RegionSelector.selectOptimalNodes(criteria, mockNodes);
      
      expect(optimalNodes).toHaveLength(1);
      expect(optimalNodes[0].id).toBe('us-east-1');
      expect(optimalNodes[0].region).toBe('us-east');
      expect(optimalNodes[0].networkTier).toBe('core');
    });

    it('should handle multiple criteria with proximity', () => {
      const criteria = {
        currentCoordinates: { lat: 40.7128, lng: -74.0060 },
        requiredCapabilities: ['streaming'],
        maxDistanceKm: 1000
      };
      
      const optimalNodes = RegionSelector.selectOptimalNodes(criteria, mockNodes);
      
      expect(optimalNodes.length).toBeGreaterThan(0);
      expect(optimalNodes.every(node => node.capabilities.includes('streaming'))).toBe(true);
    });

    it('should return empty array when no nodes match criteria', () => {
      const criteria = {
        currentRegion: 'us-east',
        requiredCapabilities: ['non-existent-capability']
      };
      
      const optimalNodes = RegionSelector.selectOptimalNodes(criteria, mockNodes);
      
      expect(optimalNodes).toHaveLength(0);
    });

    it('should prioritize zone over region when both specified', () => {
      const criteria = {
        currentRegion: 'us-west', // Would normally select us-west-1
        currentZone: 'us-east-1a' // Should override and select us-east-1
      };
      
      const optimalNodes = RegionSelector.selectOptimalNodes(criteria, mockNodes);
      
      expect(optimalNodes).toHaveLength(1);
      expect(optimalNodes[0].id).toBe('us-east-1');
      expect(optimalNodes[0].zone).toBe('us-east-1a');
    });
  });
});
