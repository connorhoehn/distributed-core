/**
 * Distance calculation utilities for geographic routing
 */

export interface Coordinates {
  lat: number;
  lng: number;
}

/**
 * Calculate the great circle distance between two points using the Haversine formula
 * @param coord1 First coordinate
 * @param coord2 Second coordinate
 * @returns Distance in kilometers
 */
export function calculateDistance(coord1: Coordinates, coord2: Coordinates): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRadians(coord2.lat - coord1.lat);
  const dLng = toRadians(coord2.lng - coord1.lng);
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(coord1.lat)) * Math.cos(toRadians(coord2.lat)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Convert degrees to radians
 */
function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Parse coordinate string into Coordinates object
 * @param coordString Coordinate string in format "lat,lng"
 * @returns Coordinates object or null if invalid
 */
export function parseCoordinates(coordString: string): Coordinates | null {
  if (!coordString || typeof coordString !== 'string') {
    return null;
  }
  
  const parts = coordString.split(',');
  if (parts.length !== 2) {
    return null;
  }
  
  const lat = parseFloat(parts[0].trim());
  const lng = parseFloat(parts[1].trim());
  
  if (isNaN(lat) || isNaN(lng)) {
    return null;
  }
  
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }
  
  return { lat, lng };
}

/**
 * Find the closest node from a list of coordinates
 * @param origin Origin coordinates
 * @param targets Array of target coordinates with identifiers
 * @returns Closest target or null if none found
 */
export function findClosestNode(
  origin: Coordinates,
  targets: Array<{ id: string; coordinates: Coordinates }>
): { id: string; coordinates: Coordinates; distance: number } | null {
  if (!targets || targets.length === 0) {
    return null;
  }
  
  let closest = targets[0];
  let minDistance = calculateDistance(origin, closest.coordinates);
  
  for (let i = 1; i < targets.length; i++) {
    const distance = calculateDistance(origin, targets[i].coordinates);
    if (distance < minDistance) {
      minDistance = distance;
      closest = targets[i];
    }
  }
  
  return {
    id: closest.id,
    coordinates: closest.coordinates,
    distance: minDistance
  };
}

describe('Distance Calculations', () => {
  describe('Haversine Distance Formula', () => {
    it('should calculate distance between known cities correctly', () => {
      // NYC to London: ~5585 km
      const nyc = { lat: 40.7128, lng: -74.0060 };
      const london = { lat: 51.5074, lng: -0.1278 };
      const distance = calculateDistance(nyc, london);
      
      expect(distance).toBeCloseTo(5585, -2); // Within 100km tolerance
    });

    it('should calculate distance between same point as zero', () => {
      const point = { lat: 40.7128, lng: -74.0060 };
      const distance = calculateDistance(point, point);
      
      expect(distance).toBe(0);
    });

    it('should handle antipodal points correctly', () => {
      // Points on opposite sides of Earth
      const point1 = { lat: 0, lng: 0 };
      const point2 = { lat: 0, lng: 180 };
      const distance = calculateDistance(point1, point2);
      
      // Should be approximately half Earth's circumference
      expect(distance).toBeCloseTo(20015, -2);
    });

    it('should handle polar coordinates', () => {
      const northPole = { lat: 90, lng: 0 };
      const southPole = { lat: -90, lng: 0 };
      const distance = calculateDistance(northPole, southPole);
      
      // Should be approximately half Earth's circumference
      expect(distance).toBeCloseTo(20015, -2);
    });
  });

  describe('Coordinate Parsing', () => {
    it('should parse valid coordinate strings', () => {
      const testCases = [
        { input: '40.7128,-74.0060', expected: { lat: 40.7128, lng: -74.0060 } },
        { input: '0,0', expected: { lat: 0, lng: 0 } },
        { input: '-33.8688,151.2093', expected: { lat: -33.8688, lng: 151.2093 } },
        { input: '90,-180', expected: { lat: 90, lng: -180 } },
      ];

      testCases.forEach(({ input, expected }) => {
        const result = parseCoordinates(input);
        expect(result).toEqual(expected);
      });
    });

    it('should reject invalid coordinate strings', () => {
      const invalidInputs = [
        '',
        'invalid',
        '40.7128',
        '40.7128,-74.0060,extra',
        'lat,lng',
        '91,0',    // Invalid latitude
        '0,181',   // Invalid longitude
        null,
        undefined,
      ];

      invalidInputs.forEach(input => {
        const result = parseCoordinates(input as any);
        expect(result).toBeNull();
      });
    });
  });

  describe('Closest Node Finding', () => {
    it('should find the closest node from multiple targets', () => {
      const origin = { lat: 40.7128, lng: -74.0060 }; // NYC
      const targets = [
        { id: 'london', coordinates: { lat: 51.5074, lng: -0.1278 } },
        { id: 'boston', coordinates: { lat: 42.3601, lng: -71.0589 } },
        { id: 'philadelphia', coordinates: { lat: 39.9526, lng: -75.1652 } },
      ];

      const closest = findClosestNode(origin, targets);
      
      expect(closest?.id).toBe('philadelphia'); // Closest to NYC
      expect(closest?.distance).toBeLessThan(200); // Should be less than 200km
    });

    it('should handle single target', () => {
      const origin = { lat: 40.7128, lng: -74.0060 };
      const targets = [
        { id: 'single', coordinates: { lat: 42.3601, lng: -71.0589 } },
      ];

      const closest = findClosestNode(origin, targets);
      
      expect(closest?.id).toBe('single');
      expect(closest?.distance).toBeGreaterThan(0);
    });

    it('should return null for empty targets', () => {
      const origin = { lat: 40.7128, lng: -74.0060 };
      const closest = findClosestNode(origin, []);
      
      expect(closest).toBeNull();
    });
  });

  describe('Geographic Utilities Edge Cases', () => {
    it('should handle coordinates at date line', () => {
      const point1 = { lat: 0, lng: 179 };
      const point2 = { lat: 0, lng: -179 };
      const distance = calculateDistance(point1, point2);
      
      // Should be short distance across date line, not around the world
      expect(distance).toBeLessThan(500);
    });

    it('should handle very small distances', () => {
      const point1 = { lat: 40.7128, lng: -74.0060 };
      const point2 = { lat: 40.7129, lng: -74.0061 }; // Very close
      const distance = calculateDistance(point1, point2);
      
      expect(distance).toBeGreaterThan(0);
      expect(distance).toBeLessThan(1); // Less than 1km
    });
  });
});
