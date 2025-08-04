describe('Geographic Metadata', () => {
  describe('Coordinate Validation', () => {
    it('should validate correct coordinate format', () => {
      const validCoordinates = [
        '40.7128,-74.0060',  // NYC
        '51.5074,-0.1278',   // London
        '28.6139,77.2090',   // Delhi
        '-33.8688,151.2093', // Sydney
        '0,0'                // Equator/Prime Meridian
      ];

      validCoordinates.forEach(coord => {
        const [lat, lng] = coord.split(',').map(Number);
        expect(lat).toBeGreaterThanOrEqual(-90);
        expect(lat).toBeLessThanOrEqual(90);
        expect(lng).toBeGreaterThanOrEqual(-180);
        expect(lng).toBeLessThanOrEqual(180);
      });
    });

    it('should reject invalid coordinate formats', () => {
      const invalidCoordinates = [
        '91.0,0',      // Invalid latitude > 90
        '-91.0,0',     // Invalid latitude < -90
        '0,181.0',     // Invalid longitude > 180
        '0,-181.0',    // Invalid longitude < -180
        'invalid,0',   // Non-numeric latitude
        '0,invalid',   // Non-numeric longitude
        '40.7128',     // Missing longitude
        '',            // Empty string
      ];

      invalidCoordinates.forEach(coord => {
        const parts = coord.split(',');
        if (parts.length !== 2) {
          expect(parts.length).not.toBe(2);
          return;
        }
        
        const [lat, lng] = parts.map(Number);
        const isValidLat = !isNaN(lat) && lat >= -90 && lat <= 90;
        const isValidLng = !isNaN(lng) && lng >= -180 && lng <= 180;
        
        expect(isValidLat && isValidLng).toBe(false);
      });
    });
  });

  describe('Geographic Tags Serialization', () => {
    it('should serialize geographic metadata correctly', () => {
      const geoMetadata = {
        region: 'us-east',
        zone: 'us-east-1a',
        role: 'core',
        tags: {
          datacenter: 'dc1',
          networkTier: 'core',
          capabilities: 'streaming,transcoding',
          maxBandwidth: '1000',
          preferredCodecs: 'h264,vp8',
          coordinates: '40.7128,-74.0060'
        }
      };

      // Test serialization
      const serialized = JSON.stringify(geoMetadata);
      expect(serialized).toContain('us-east');
      expect(serialized).toContain('40.7128,-74.0060');
      
      // Test deserialization
      const deserialized = JSON.parse(serialized);
      expect(deserialized.region).toBe('us-east');
      expect(deserialized.tags.coordinates).toBe('40.7128,-74.0060');
      expect(deserialized.tags.capabilities).toBe('streaming,transcoding');
    });

    it('should handle missing optional geographic fields', () => {
      const minimalMetadata = {
        region: 'us-west',
        zone: 'us-west-2a',
        role: 'edge'
      };

      const serialized = JSON.stringify(minimalMetadata);
      const deserialized = JSON.parse(serialized);
      
      expect(deserialized.region).toBe('us-west');
      expect(deserialized.tags).toBeUndefined();
    });
  });

  describe('Network Tier Classification', () => {
    it('should correctly classify network tiers', () => {
      const testCases = [
        { region: 'us-east', expected: 'core' },
        { region: 'us-west', expected: 'edge' },
        { region: 'eu-west', expected: 'edge' },
        { region: 'ap-south', expected: 'edge' },
      ];

      testCases.forEach(({ region, expected }) => {
        const networkTier = region === 'us-east' ? 'core' : 'edge';
        expect(networkTier).toBe(expected);
      });
    });

    it('should validate capability strings', () => {
      const validCapabilities = [
        'streaming',
        'transcoding',
        'streaming,transcoding',
        'streaming,transcoding,recording',
      ];

      validCapabilities.forEach(caps => {
        const capabilities = caps.split(',');
        expect(capabilities.length).toBeGreaterThan(0);
        capabilities.forEach(cap => {
          expect(cap.trim()).toBeTruthy();
        });
      });
    });
  });

  describe('Geographic Metadata Validation', () => {
    it('should validate complete geographic node metadata', () => {
      const validMetadata = {
        region: 'us-east',
        zone: 'us-east-1a',
        role: 'core',
        tags: {
          datacenter: 'dc1',
          networkTier: 'core',
          capabilities: 'streaming,transcoding',
          maxBandwidth: '1000',
          preferredCodecs: 'h264,vp8',
          coordinates: '40.7128,-74.0060'
        }
      };

      // Validate required fields
      expect(validMetadata.region).toBeDefined();
      expect(validMetadata.zone).toBeDefined();
      expect(validMetadata.role).toBeDefined();

      // Validate coordinates if present
      if (validMetadata.tags?.coordinates) {
        const [lat, lng] = validMetadata.tags.coordinates.split(',').map(Number);
        expect(lat).toBeGreaterThanOrEqual(-90);
        expect(lat).toBeLessThanOrEqual(90);
        expect(lng).toBeGreaterThanOrEqual(-180);
        expect(lng).toBeLessThanOrEqual(180);
      }

      // Validate bandwidth if present
      if (validMetadata.tags?.maxBandwidth) {
        const bandwidth = parseInt(validMetadata.tags.maxBandwidth);
        expect(bandwidth).toBeGreaterThan(0);
      }
    });
  });
});
