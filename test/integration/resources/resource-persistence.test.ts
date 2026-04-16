import { ResourceRegistry, ResourceRegistryConfig } from '../../../src/resources/core/ResourceRegistry';
import { ResourceMetadata, ResourceState, ResourceHealth, ResourceTypeDefinition } from '../../../src/resources/types';
import { WALWriterImpl } from '../../../src/persistence/wal/WALWriter';
import { WALReaderImpl } from '../../../src/persistence/wal/WALReader';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Resource persistence via WAL', () => {
  let tmpDir: string;
  let walDir: string;
  let walFilePath: string;

  const NODE_ID = 'test-node-1';

  const testResourceType: ResourceTypeDefinition = {
    name: 'TestWorker',
    typeName: 'test-worker',
    version: '1.0.0',
    schema: {},
  };

  function makeResource(id: string, extra?: Partial<ResourceMetadata>): ResourceMetadata {
    return {
      id,
      resourceId: id,
      type: 'test-worker',
      resourceType: 'test-worker',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      nodeId: NODE_ID,
      state: ResourceState.ACTIVE,
      health: ResourceHealth.HEALTHY,
      ...extra,
    };
  }

  function createRegistryConfig(overrides?: Partial<ResourceRegistryConfig>): ResourceRegistryConfig {
    return {
      nodeId: NODE_ID,
      entityRegistryType: 'memory',
      ...overrides,
    };
  }

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-persistence-test-'));
    walDir = path.join(tmpDir, 'wal');
    await fs.mkdir(walDir, { recursive: true });
    walFilePath = path.join(walDir, 'resource.wal');
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should persist resource CRUD operations to WAL and recover them in a new registry', async () => {
    // -------------------------------------------------------
    // Phase 1: Set up WAL writer and first ResourceRegistry
    // -------------------------------------------------------
    const walWriter = new WALWriterImpl({
      filePath: walFilePath,
      syncInterval: 0, // disable periodic sync for deterministic tests
    });
    await walWriter.initialize();

    const registry1 = new ResourceRegistry({
      ...createRegistryConfig(),
      walWriter: walWriter as any, // WAL integration being added by another agent
    });
    registry1.registerResourceType(testResourceType);
    await registry1.start();

    // -------------------------------------------------------
    // Phase 2: Perform CRUD operations
    // -------------------------------------------------------

    // Create 3 resources
    const resourceA = await registry1.createResource(makeResource('res-alpha', {
      applicationData: { role: 'primary' },
    }));
    const resourceB = await registry1.createResource(makeResource('res-beta', {
      applicationData: { role: 'secondary' },
    }));
    const resourceC = await registry1.createResource(makeResource('res-gamma', {
      applicationData: { role: 'tertiary' },
    }));

    // Verify all 3 exist
    expect(await registry1.getResource('res-alpha')).not.toBeNull();
    expect(await registry1.getResource('res-beta')).not.toBeNull();
    expect(await registry1.getResource('res-gamma')).not.toBeNull();

    // Update resource B with new application data
    const updatedB = await registry1.updateResource('res-beta', {
      applicationData: { role: 'secondary', priority: 'high' },
      state: ResourceState.SCALING,
    });
    expect(updatedB.applicationData).toEqual({ role: 'secondary', priority: 'high' });
    expect(updatedB.state).toBe(ResourceState.SCALING);

    // Delete resource C
    await registry1.removeResource('res-gamma');
    expect(await registry1.getResource('res-gamma')).toBeNull();

    // Final state in registry1: res-alpha (unchanged), res-beta (updated), res-gamma (deleted)
    const remaining = registry1.getAllResources();
    expect(remaining).toHaveLength(2);

    // Flush WAL and shut down
    await walWriter.flush();
    await registry1.stop();
    await walWriter.close();

    // -------------------------------------------------------
    // Phase 3: Create a NEW ResourceRegistry and recover from WAL
    // -------------------------------------------------------
    const walReader = new WALReaderImpl(walFilePath);
    await walReader.initialize();

    const registry2 = new ResourceRegistry({
      ...createRegistryConfig(),
    });
    registry2.registerResourceType(testResourceType);
    await registry2.start();

    // Recover state from WAL
    await (registry2 as any).recoverFromWAL(walReader);

    // -------------------------------------------------------
    // Phase 4: Verify recovered state
    // -------------------------------------------------------

    // Should have exactly 2 resources (res-gamma was deleted)
    const recoveredResources = registry2.getAllResources();
    expect(recoveredResources).toHaveLength(2);

    const recoveredIds = recoveredResources.map(r => r.resourceId).sort();
    expect(recoveredIds).toEqual(['res-alpha', 'res-beta']);

    // res-alpha should be unchanged
    const recoveredA = await registry2.getResource('res-alpha');
    expect(recoveredA).not.toBeNull();
    expect(recoveredA!.resourceType).toBe('test-worker');
    expect(recoveredA!.applicationData).toEqual({ role: 'primary' });
    expect(recoveredA!.state).toBe(ResourceState.ACTIVE);

    // res-beta should reflect the update
    const recoveredB = await registry2.getResource('res-beta');
    expect(recoveredB).not.toBeNull();
    expect(recoveredB!.applicationData).toEqual({ role: 'secondary', priority: 'high' });
    expect(recoveredB!.state).toBe(ResourceState.SCALING);

    // res-gamma should NOT exist
    const recoveredC = await registry2.getResource('res-gamma');
    expect(recoveredC).toBeNull();

    await registry2.stop();
    await walReader.close();
  }, 15_000);

  it('should recover resources with correct metadata fields preserved', async () => {
    // Use a separate WAL directory to avoid interference
    const metaWalDir = path.join(tmpDir, 'wal-metadata');
    await fs.mkdir(metaWalDir, { recursive: true });
    const metaWalPath = path.join(metaWalDir, 'metadata.wal');

    const walWriter = new WALWriterImpl({
      filePath: metaWalPath,
      syncInterval: 0,
    });
    await walWriter.initialize();

    const registry = new ResourceRegistry({
      ...createRegistryConfig(),
      walWriter: walWriter as any,
    });
    registry.registerResourceType(testResourceType);
    await registry.start();

    // Create a resource with rich metadata
    await registry.createResource(makeResource('res-rich', {
      tags: { env: 'production', tier: 'critical' },
      applicationData: { config: { retries: 3, timeout: 5000 } },
      capacity: { current: 50, maximum: 100, reserved: 10, unit: 'connections' },
    }));

    await walWriter.flush();
    await registry.stop();
    await walWriter.close();

    // Recover in a new registry
    const walReader = new WALReaderImpl(metaWalPath);
    await walReader.initialize();

    const registry2 = new ResourceRegistry(createRegistryConfig());
    registry2.registerResourceType(testResourceType);
    await registry2.start();

    await (registry2 as any).recoverFromWAL(walReader);

    const recovered = await registry2.getResource('res-rich');
    expect(recovered).not.toBeNull();
    expect(recovered!.tags).toEqual({ env: 'production', tier: 'critical' });
    expect(recovered!.applicationData).toEqual({ config: { retries: 3, timeout: 5000 } });
    expect(recovered!.capacity).toEqual({ current: 50, maximum: 100, reserved: 10, unit: 'connections' });
    expect(recovered!.health).toBe(ResourceHealth.HEALTHY);

    await registry2.stop();
    await walReader.close();
  }, 15_000);

  it('should handle multiple updates to the same resource during recovery', async () => {
    const multiWalDir = path.join(tmpDir, 'wal-multi-update');
    await fs.mkdir(multiWalDir, { recursive: true });
    const multiWalPath = path.join(multiWalDir, 'multi.wal');

    const walWriter = new WALWriterImpl({
      filePath: multiWalPath,
      syncInterval: 0,
    });
    await walWriter.initialize();

    const registry = new ResourceRegistry({
      ...createRegistryConfig(),
      walWriter: walWriter as any,
    });
    registry.registerResourceType(testResourceType);
    await registry.start();

    // Create then update the same resource multiple times
    await registry.createResource(makeResource('res-evolving', {
      applicationData: { version: 1 },
    }));
    await registry.updateResource('res-evolving', {
      applicationData: { version: 2 },
      state: ResourceState.SCALING,
    });
    await registry.updateResource('res-evolving', {
      applicationData: { version: 3 },
      state: ResourceState.ACTIVE,
      health: ResourceHealth.DEGRADED,
    });

    await walWriter.flush();
    await registry.stop();
    await walWriter.close();

    // Recover -- final state should reflect the last update
    const walReader = new WALReaderImpl(multiWalPath);
    await walReader.initialize();

    const registry2 = new ResourceRegistry(createRegistryConfig());
    registry2.registerResourceType(testResourceType);
    await registry2.start();

    await (registry2 as any).recoverFromWAL(walReader);

    const recovered = await registry2.getResource('res-evolving');
    expect(recovered).not.toBeNull();
    expect(recovered!.applicationData).toEqual({ version: 3 });
    expect(recovered!.state).toBe(ResourceState.ACTIVE);
    expect(recovered!.health).toBe(ResourceHealth.DEGRADED);

    await registry2.stop();
    await walReader.close();
  }, 15_000);

  it('should recover an empty registry when all resources were deleted', async () => {
    const emptyWalDir = path.join(tmpDir, 'wal-all-deleted');
    await fs.mkdir(emptyWalDir, { recursive: true });
    const emptyWalPath = path.join(emptyWalDir, 'empty.wal');

    const walWriter = new WALWriterImpl({
      filePath: emptyWalPath,
      syncInterval: 0,
    });
    await walWriter.initialize();

    const registry = new ResourceRegistry({
      ...createRegistryConfig(),
      walWriter: walWriter as any,
    });
    registry.registerResourceType(testResourceType);
    await registry.start();

    // Create 2 resources then delete both
    await registry.createResource(makeResource('res-temp-1'));
    await registry.createResource(makeResource('res-temp-2'));
    await registry.removeResource('res-temp-1');
    await registry.removeResource('res-temp-2');

    expect(registry.getAllResources()).toHaveLength(0);

    await walWriter.flush();
    await registry.stop();
    await walWriter.close();

    // Recover -- should have zero resources
    const walReader = new WALReaderImpl(emptyWalPath);
    await walReader.initialize();

    const registry2 = new ResourceRegistry(createRegistryConfig());
    registry2.registerResourceType(testResourceType);
    await registry2.start();

    await (registry2 as any).recoverFromWAL(walReader);

    expect(registry2.getAllResources()).toHaveLength(0);
    expect(await registry2.getResource('res-temp-1')).toBeNull();
    expect(await registry2.getResource('res-temp-2')).toBeNull();

    await registry2.stop();
    await walReader.close();
  }, 15_000);
});
