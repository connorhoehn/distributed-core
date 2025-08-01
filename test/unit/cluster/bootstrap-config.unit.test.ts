import { BootstrapConfig } from '../../../src/cluster/config/BootstrapConfig';

describe('BootstrapConfig', () => {
  it('should create config with default values', () => {
    const config = BootstrapConfig.create();
    
    expect(config.getSeedNodes()).toEqual([]);
    expect(config.joinTimeout).toBe(5000);
    expect(config.gossipInterval).toBe(1000);
  });

  it('should create config with custom values', () => {
    const seedNode = 'seed-1';
    const config = BootstrapConfig.create({
      seedNodes: [seedNode],
      joinTimeout: 3000,
      gossipInterval: 500
    });
    
    expect(config.getSeedNodes()).toEqual([seedNode]);
    expect(config.joinTimeout).toBe(3000);
    expect(config.gossipInterval).toBe(500);
  });

  it('should add and get seed nodes', () => {
    const config = new BootstrapConfig();
    const seedNode = 'seed-1';
    
    config.addSeedNode(seedNode);
    const seedNodes = config.getSeedNodes();
    
    expect(seedNodes).toHaveLength(1);
    expect(seedNodes[0]).toEqual(seedNode);
  });

  describe('Enhanced Seed Features', () => {
    it('should add structured seed nodes', () => {
      const config = BootstrapConfig.create();
      
      config.addStructuredSeed({
        id: 'seed-1',
        address: '192.168.1.100',
        port: 8080,
        priority: 100,
        isPermanent: true
      });

      const structuredSeeds = config.getStructuredSeeds();
      expect(structuredSeeds).toHaveLength(1);
      expect(structuredSeeds[0].id).toBe('seed-1');
      expect(structuredSeeds[0].health.isAvailable).toBe(true);
    });

    it('should get available seeds ordered by priority', () => {
      const config = BootstrapConfig.create();
      
      config.addStructuredSeed({
        id: 'seed-low',
        address: '192.168.1.100',
        port: 8080,
        priority: 50,
        isPermanent: true
      });

      config.addStructuredSeed({
        id: 'seed-high',
        address: '192.168.1.101',
        port: 8080,
        priority: 100,
        isPermanent: true
      });

      const availableSeeds = config.getAvailableSeeds();
      expect(availableSeeds).toHaveLength(2);
      expect(availableSeeds[0].id).toBe('seed-high'); // Higher priority first
      expect(availableSeeds[1].id).toBe('seed-low');
    });

    it('should handle seed failures', () => {
      const config = BootstrapConfig.create();
      
      config.addStructuredSeed({
        id: 'seed-1',
        address: '192.168.1.100',
        port: 8080,
        priority: 100,
        isPermanent: true
      });

      // Initially available
      expect(config.getAvailableSeeds()).toHaveLength(1);

      // Mark as failed multiple times
      config.markSeedFailure('seed-1');
      config.markSeedFailure('seed-1');
      config.markSeedFailure('seed-1'); // Should become unavailable after 3 failures

      const availableAfterFailures = config.getAvailableSeeds();
      expect(availableAfterFailures).toHaveLength(0);
    });

    it('should emit events for seed lifecycle', (done) => {
      const config = BootstrapConfig.create();
      
      config.on('seed-added', (event) => {
        expect(event.seed.id).toBe('test-seed');
        done();
      });

      config.addStructuredSeed({
        id: 'test-seed',
        address: '192.168.1.100',
        port: 8080,
        priority: 100,
        isPermanent: true
      });
    });

    it('should convert legacy seeds to structured format', () => {
      const legacySeeds = ['192.168.1.100:8080', '192.168.1.101:9000'];
      const structured = BootstrapConfig.fromStringArray(legacySeeds);

      expect(structured).toHaveLength(2);
      expect(structured[0].address).toBe('192.168.1.100');
      expect(structured[0].port).toBe(8080);
      expect(structured[1].address).toBe('192.168.1.101');
      expect(structured[1].port).toBe(9000);
    });

    it('should provide health status information', () => {
      const config = BootstrapConfig.create();
      
      config.addStructuredSeed({
        id: 'seed-1',
        address: '192.168.1.100',
        port: 8080,
        priority: 100,
        isPermanent: true
      });

      const healthStatus = config.getHealthStatus();
      expect(healthStatus.totalSeeds).toBe(1);
      expect(healthStatus.availableSeeds).toBe(1);
      expect(healthStatus.failedSeeds).toBe(0);
      expect(healthStatus.seedDetails).toHaveLength(1);
    });

    it('should get bootstrap seeds with proper ordering', () => {
      const config = BootstrapConfig.create();
      
      // Add permanent seeds
      config.addStructuredSeed({
        id: 'permanent-high',
        address: '192.168.1.100',
        port: 8080,
        priority: 100,
        isPermanent: true
      });

      config.addStructuredSeed({
        id: 'permanent-low',
        address: '192.168.1.101',
        port: 8080,
        priority: 50,
        isPermanent: true
      });

      // Add temporary seed
      config.addStructuredSeed({
        id: 'temporary',
        address: '192.168.1.102',
        port: 8080,
        priority: 75,
        isPermanent: false
      });

      const bootstrapSeeds = config.getBootstrapSeeds();
      
      // Should prioritize permanent seeds first, then temporary
      expect(bootstrapSeeds[0].id).toBe('permanent-high');
      expect(bootstrapSeeds[1].id).toBe('permanent-low');
      expect(bootstrapSeeds[2].id).toBe('temporary');
    });
  });
});
