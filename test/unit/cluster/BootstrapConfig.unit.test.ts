import { BootstrapConfig } from '../../../src/cluster/BootstrapConfig';

describe('BootstrapConfig', () => {
  it('should create config with default values', () => {
    const config = BootstrapConfig.create();
    
    expect(config.seedNodes).toEqual([]);
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
    
    expect(config.seedNodes).toEqual([seedNode]);
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
});
