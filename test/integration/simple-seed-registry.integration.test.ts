import { SeedNodeRegistry } from '../../src/cluster/seeding/SeedNodeRegistry';

describe('SeedNodeRegistry Basic Integration', () => {
  it('should create a registry and add seeds', () => {
    const registry = new SeedNodeRegistry();
    
    registry.addSeed({
      id: 'test-seed',
      address: '127.0.0.1',
      port: 8080,
      priority: 100,
      isPermanent: true
    });
    
    const seeds = registry.getAllSeeds();
    expect(seeds).toHaveLength(1);
    expect(seeds[0].id).toBe('test-seed');
    expect(seeds[0].address).toBe('127.0.0.1');
    
    registry.stopHealthMonitoring();
  });
});
