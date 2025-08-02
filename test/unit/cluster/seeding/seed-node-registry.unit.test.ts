import { SeedNodeRegistry, SeedNodeInfo } from '../../../../src/cluster/seeding/SeedNodeRegistry';

describe('SeedNodeRegistry', () => {
  let registry: SeedNodeRegistry;

  beforeEach(() => {
    registry = new SeedNodeRegistry({
      healthCheckInterval: 100, // Fast for testing
      maxFailures: 2,
      failureTimeout: 200
    });
  });

  afterEach(() => {
    registry.stopHealthMonitoring();
  });

  describe('Basic Operations', () => {
    it('should add and retrieve seed nodes', () => {
      const seed: Omit<SeedNodeInfo, 'health'> = {
        id: 'test-seed-1',
        address: '192.168.1.100',
        port: 8080,
        priority: 100,
        isPermanent: true,
        metadata: { region: 'us-east-1', zone: 'us-east-1a' }
      };

      registry.addSeed(seed);
      const seeds = registry.getAllSeeds();

      expect(seeds).toHaveLength(1);
      expect(seeds[0].id).toBe('test-seed-1');
      expect(seeds[0].address).toBe('192.168.1.100');
      expect(seeds[0].health.isAvailable).toBe(true);
    });

    it('should remove seed nodes', () => {
      const seed: Omit<SeedNodeInfo, 'health'> = {
        id: 'test-seed-1',
        address: '192.168.1.100',
        port: 8080,
        priority: 100,
        isPermanent: true
      };

      registry.addSeed(seed);
      expect(registry.getAllSeeds()).toHaveLength(1);

      const removed = registry.removeSeed('test-seed-1');
      expect(removed).toBe(true);
      expect(registry.getAllSeeds()).toHaveLength(0);

      const removedAgain = registry.removeSeed('test-seed-1');
      expect(removedAgain).toBe(false);
    });

    it('should get available seeds ordered by priority', () => {
      const seeds: Array<Omit<SeedNodeInfo, 'health'>> = [
        { id: 'seed-1', address: '192.168.1.100', port: 8080, priority: 50, isPermanent: true },
        { id: 'seed-2', address: '192.168.1.101', port: 8080, priority: 100, isPermanent: true },
        { id: 'seed-3', address: '192.168.1.102', port: 8080, priority: 75, isPermanent: true }
      ];

      for (const seed of seeds) {
        registry.addSeed(seed);
      }

      const availableSeeds = registry.getAvailableSeeds();
      expect(availableSeeds).toHaveLength(3);
      expect(availableSeeds[0].priority).toBe(100); // Highest priority first
      expect(availableSeeds[1].priority).toBe(75);
      expect(availableSeeds[2].priority).toBe(50);
    });
  });

  describe('Permanent vs Temporary Seeds', () => {
    it('should distinguish permanent from temporary seeds', () => {
      const permanentSeed: Omit<SeedNodeInfo, 'health'> = {
        id: 'permanent-seed',
        address: '192.168.1.100',
        port: 8080,
        priority: 100,
        isPermanent: true
      };

      const temporarySeed: Omit<SeedNodeInfo, 'health'> = {
        id: 'temporary-seed',
        address: '192.168.1.101',
        port: 8080,
        priority: 50,
        isPermanent: false
      };

      registry.addSeed(permanentSeed);
      registry.addSeed(temporarySeed);

      const permanent = registry.getPermanentSeeds();
      expect(permanent).toHaveLength(1);
      expect(permanent[0].id).toBe('permanent-seed');

      const bootstrap = registry.getBootstrapSeeds();
      expect(bootstrap).toHaveLength(2); // Both available for bootstrap
    });

    it('should prioritize permanent seeds in bootstrap', () => {
      const permanentSeed: Omit<SeedNodeInfo, 'health'> = {
        id: 'permanent-seed',
        address: '192.168.1.100',
        port: 8080,
        priority: 50, // Lower priority
        isPermanent: true
      };

      const temporarySeed: Omit<SeedNodeInfo, 'health'> = {
        id: 'temporary-seed',
        address: '192.168.1.101',
        port: 8080,
        priority: 100, // Higher priority but temporary
        isPermanent: false
      };

      registry.addSeed(permanentSeed);
      registry.addSeed(temporarySeed);

      const bootstrap = registry.getBootstrapSeeds();
      expect(bootstrap[0].isPermanent).toBe(true); // Permanent first
      expect(bootstrap[1].isPermanent).toBe(false);
    });
  });

  describe('Health Tracking', () => {
    it('should track seed health status', () => {
      const seed: Omit<SeedNodeInfo, 'health'> = {
        id: 'test-seed',
        address: '192.168.1.100',
        port: 8080,
        priority: 100,
        isPermanent: true
      };

      registry.addSeed(seed);

      let status = registry.getHealthStatus();
      expect(status.totalSeeds).toBe(1);
      expect(status.availableSeeds).toBe(1);
      expect(status.healthyRatio).toBe(1.0);

      // Mark as failed
      registry.markSeedFailure('test-seed');
      status = registry.getHealthStatus();
      expect(status.degradedSeeds).toHaveLength(1);

      // Mark as failed again (should become unavailable)
      registry.markSeedFailure('test-seed');
      status = registry.getHealthStatus();
      expect(status.availableSeeds).toBe(0);
      expect(status.failedSeeds).toHaveLength(1);
    });

    it('should recover seeds after success', () => {
      const seed: Omit<SeedNodeInfo, 'health'> = {
        id: 'test-seed',
        address: '192.168.1.100',
        port: 8080,
        priority: 100,
        isPermanent: true
      };

      registry.addSeed(seed);

      // Fail the seed multiple times
      registry.markSeedFailure('test-seed');
      registry.markSeedFailure('test-seed');

      let status = registry.getHealthStatus();
      expect(status.availableSeeds).toBe(0);

      // Mark as successful
      registry.markSeedSuccess('test-seed');
      status = registry.getHealthStatus();
      expect(status.availableSeeds).toBe(1);
      expect(status.healthyRatio).toBe(1.0);
    });

    it('should emit events for health changes', async () => {
      let addedEvent: any = null;
      let degradedEvent: any = null;
      let failedEvent: any = null;
      let recoveredEvent: any = null;

      // Register event listeners first
      registry.on('seed-added', (event) => { addedEvent = event; });
      registry.on('seed-degraded', (event) => { degradedEvent = event; });
      registry.on('seed-failed', (event) => { failedEvent = event; });
      registry.on('seed-recovered', (event) => { recoveredEvent = event; });

      const seed: Omit<SeedNodeInfo, 'health'> = {
        id: 'test-seed',
        address: '192.168.1.100',
        port: 8080,
        priority: 100,
        isPermanent: true
      };

      // Now add the seed - this should trigger the event
      registry.addSeed(seed);

      // Add event should have been emitted
      expect(addedEvent).toBeTruthy();
      expect(addedEvent.seed.id).toBe('test-seed');

      // Test degraded event
      registry.markSeedFailure('test-seed');
      expect(degradedEvent).toBeTruthy();
      expect(degradedEvent.failures).toBe(1);

      // Test failed event
      registry.markSeedFailure('test-seed');
      expect(failedEvent).toBeTruthy();

      // Test recovery event
      registry.markSeedSuccess('test-seed');
      expect(recoveredEvent).toBeTruthy();
    });
  });

  describe('Legacy Compatibility', () => {
    it('should convert from string array', () => {
      const seedStrings = ['192.168.1.100:8080', '192.168.1.101', 'example.com:9000'];
      const seeds = SeedNodeRegistry.fromStringArray(seedStrings);

      expect(seeds).toHaveLength(3);
      expect(seeds[0].address).toBe('192.168.1.100');
      expect(seeds[0].port).toBe(8080);
      expect(seeds[1].address).toBe('192.168.1.101');
      expect(seeds[1].port).toBe(8080); // Default port
      expect(seeds[2].address).toBe('example.com');
      expect(seeds[2].port).toBe(9000);
    });

    it('should convert to legacy string array', () => {
      const seeds: Array<Omit<SeedNodeInfo, 'health'>> = [
        { id: 'seed-1', address: '192.168.1.100', port: 8080, priority: 100, isPermanent: true },
        { id: 'seed-2', address: '192.168.1.101', port: 9000, priority: 50, isPermanent: true }
      ];

      for (const seed of seeds) {
        registry.addSeed(seed);
      }

      const legacyStrings = registry.toLegacyStringArray();
      expect(legacyStrings).toHaveLength(2);
      expect(legacyStrings[0]).toBe('192.168.1.100:8080'); // Higher priority first
      expect(legacyStrings[1]).toBe('192.168.1.101:9000');
    });
  });

  describe('Health Monitoring', () => {
    it('should auto-recover failed seeds after timeout', async () => {
      const seed: Omit<SeedNodeInfo, 'health'> = {
        id: 'test-seed',
        address: '192.168.1.100',
        port: 8080,
        priority: 100,
        isPermanent: true
      };

      registry.addSeed(seed);

      // Fail the seed
      registry.markSeedFailure('test-seed');
      registry.markSeedFailure('test-seed');

      expect(registry.getHealthStatus().availableSeeds).toBe(0);

      // Start health monitoring
      registry.startHealthMonitoring();

      // Wait for auto-recovery (timeout + health check interval)
      await new Promise(resolve => setTimeout(resolve, 350));

      expect(registry.getHealthStatus().availableSeeds).toBe(1);
    });

    it('should emit health check completed events', async () => {
      let healthCheckEvent: any = null;
      registry.on('health-check-completed', (event) => { 
        healthCheckEvent = event; 
      });

      const seed: Omit<SeedNodeInfo, 'health'> = {
        id: 'test-seed',
        address: '192.168.1.100',
        port: 8080,
        priority: 100,
        isPermanent: true
      };

      registry.addSeed(seed);
      registry.markSeedFailure('test-seed');
      registry.markSeedFailure('test-seed');

      registry.startHealthMonitoring();
      
      // Wait for health check
      await new Promise(resolve => setTimeout(resolve, 350));

      expect(healthCheckEvent).toBeTruthy();
      expect(healthCheckEvent.recoveredSeeds).toBe(1);
      expect(healthCheckEvent.healthStatus.availableSeeds).toBe(1);
    });
  });
});
