import { ResourceRegistry, ResourceRegistryConfig, ResourceWALData } from '../../../../src/resources/core/ResourceRegistry';
import {
  ResourceMetadata,
  ResourceTypeDefinition,
  ResourceState,
  ResourceHealth,
} from '../../../../src/resources/types';
import { WALWriter, WALReader, WALEntry, EntityUpdate } from '../../../../src/persistence/types';

/**
 * In-memory WAL implementation for testing.
 * Captures appended entries and allows a reader to replay them,
 * simulating persistence across registry instances.
 */
class InMemoryWALStore {
  entries: WALEntry[] = [];
  private lsn = 0;

  createWriter(): WALWriter {
    const store = this;
    return {
      async append(update: EntityUpdate): Promise<number> {
        const entry: WALEntry = {
          logSequenceNumber: ++store.lsn,
          timestamp: update.timestamp,
          checksum: 'test-checksum',
          data: update,
        };
        store.entries.push(entry);
        return entry.logSequenceNumber;
      },
      async flush(): Promise<void> {},
      async sync(): Promise<void> {},
      async close(): Promise<void> {},
      async truncateBefore(_lsn: number): Promise<void> {},
      getCurrentLSN(): number {
        return store.lsn;
      },
    };
  }

  createReader(): WALReader {
    const store = this;
    return {
      async readAll(): Promise<WALEntry[]> {
        return [...store.entries];
      },
      async *readFrom(logSequenceNumber: number): AsyncIterableIterator<WALEntry> {
        for (const entry of store.entries) {
          if (entry.logSequenceNumber >= logSequenceNumber) {
            yield entry;
          }
        }
      },
      async readRange(startLSN: number, endLSN: number): Promise<WALEntry[]> {
        return store.entries.filter(
          (e) => e.logSequenceNumber >= startLSN && e.logSequenceNumber <= endLSN
        );
      },
      async replay(handler: (entry: WALEntry) => Promise<void>): Promise<void> {
        for (const entry of store.entries) {
          await handler(entry);
        }
      },
      async getLastSequenceNumber(): Promise<number> {
        if (store.entries.length === 0) return 0;
        return store.entries[store.entries.length - 1].logSequenceNumber;
      },
      async getEntryCount(): Promise<number> {
        return store.entries.length;
      },
      async close(): Promise<void> {},
    };
  }
}

function makeResourceMetadata(overrides: Partial<ResourceMetadata> & { resourceId: string; resourceType: string }): ResourceMetadata {
  return {
    id: overrides.resourceId,
    type: overrides.resourceType,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    nodeId: 'test-node-1',
    timestamp: Date.now(),
    state: ResourceState.ACTIVE,
    health: ResourceHealth.HEALTHY,
    ...overrides,
  };
}

const testResourceType: ResourceTypeDefinition = {
  name: 'Test Resource',
  typeName: 'test-resource',
  version: '1.0.0',
  schema: { type: 'object' },
};

describe('ResourceRegistry WAL Persistence', () => {
  let walStore: InMemoryWALStore;

  beforeEach(() => {
    walStore = new InMemoryWALStore();
  });

  function createRegistry(walWriter?: WALWriter): ResourceRegistry {
    const config: ResourceRegistryConfig = {
      nodeId: 'test-node-1',
      entityRegistryType: 'memory',
      entityRegistryConfig: { enableTestMode: true },
      walWriter,
    };
    const registry = new ResourceRegistry(config);
    registry.registerResourceType(testResourceType);
    return registry;
  }

  test('should persist resource operations to WAL and recover them in a new registry', async () => {
    // --- Phase 1: Create a registry with WAL, add resources ---
    const writer = walStore.createWriter();
    const registry1 = createRegistry(writer);
    await registry1.start();

    const res1 = makeResourceMetadata({
      resourceId: 'resource-alpha',
      resourceType: 'test-resource',
      applicationData: { name: 'Alpha' },
    });
    const res2 = makeResourceMetadata({
      resourceId: 'resource-beta',
      resourceType: 'test-resource',
      applicationData: { name: 'Beta' },
    });

    await registry1.createResource(res1);
    await registry1.createResource(res2);

    // Update one resource
    await registry1.updateResource('resource-alpha', {
      applicationData: { name: 'Alpha Updated' },
    });

    // Remove one resource
    await registry1.removeResource('resource-beta');

    await registry1.stop();

    // Verify WAL captured all operations
    expect(walStore.entries).toHaveLength(4); // CREATE, CREATE, UPDATE, DELETE

    const operations = walStore.entries.map(
      (e) => (e.data.metadata?.resourceWAL as ResourceWALData).operation
    );
    expect(operations).toEqual(['CREATE', 'CREATE', 'UPDATE', 'DELETE']);

    // --- Phase 2: Create a new registry and recover from WAL ---
    const registry2 = createRegistry(); // no WAL writer needed for recovery
    // Entity registry must be started before recovery so proposeEntity works
    await registry2.start();

    const reader = walStore.createReader();
    const result = await registry2.recoverFromWAL(reader);

    expect(result.entriesReplayed).toBe(4);

    // resource-alpha should exist with updated data
    const recoveredAlpha = registry2.getResource('resource-alpha');
    expect(recoveredAlpha).not.toBeNull();
    expect(recoveredAlpha!.applicationData.name).toBe('Alpha Updated');

    // resource-beta should NOT exist (was deleted)
    const recoveredBeta = registry2.getResource('resource-beta');
    expect(recoveredBeta).toBeNull();

    await registry2.stop();
  });

  test('should recover multiple creates correctly', async () => {
    const writer = walStore.createWriter();
    const registry1 = createRegistry(writer);
    await registry1.start();

    for (let i = 1; i <= 5; i++) {
      await registry1.createResource(
        makeResourceMetadata({
          resourceId: `res-${i}`,
          resourceType: 'test-resource',
          applicationData: { index: i },
        })
      );
    }
    await registry1.stop();

    // Recover
    const registry2 = createRegistry();
    await registry2.start();
    await registry2.recoverFromWAL(walStore.createReader());

    const all = registry2.getAllResources();
    expect(all).toHaveLength(5);

    for (let i = 1; i <= 5; i++) {
      const r = registry2.getResource(`res-${i}`);
      expect(r).not.toBeNull();
      expect(r!.applicationData.index).toBe(i);
    }

    await registry2.stop();
  });

  test('should work without WAL writer (in-memory only, no persistence)', async () => {
    const registry = createRegistry(); // no walWriter
    await registry.start();

    const res = makeResourceMetadata({
      resourceId: 'ephemeral-resource',
      resourceType: 'test-resource',
      applicationData: { temp: true },
    });

    await registry.createResource(res);
    const retrieved = registry.getResource('ephemeral-resource');
    expect(retrieved).not.toBeNull();

    // No WAL entries should exist since we used the shared walStore
    expect(walStore.entries).toHaveLength(0);

    await registry.stop();
  });

  test('should handle recovery of DELETE for non-existent resource gracefully', async () => {
    // Manually inject a DELETE entry for a resource that was never created
    const fakeUpdate: EntityUpdate = {
      entityId: 'ghost-resource',
      timestamp: Date.now(),
      version: 1,
      operation: 'DELETE',
      metadata: {
        resourceWAL: {
          operation: 'DELETE',
          resourceId: 'ghost-resource',
          resourceMetadata: makeResourceMetadata({
            resourceId: 'ghost-resource',
            resourceType: 'test-resource',
          }),
        } as ResourceWALData,
      },
    };

    walStore.entries.push({
      logSequenceNumber: 1,
      timestamp: Date.now(),
      checksum: 'test',
      data: fakeUpdate,
    });

    const registry = createRegistry();
    await registry.start();

    // Should not throw
    const result = await registry.recoverFromWAL(walStore.createReader());
    expect(result.entriesReplayed).toBe(1);

    // Nothing should be in the registry
    expect(registry.getAllResources()).toHaveLength(0);

    await registry.stop();
  });

  test('should skip non-resource WAL entries during recovery', async () => {
    // Insert a non-resource WAL entry (no resourceWAL metadata)
    const genericUpdate: EntityUpdate = {
      entityId: 'some-entity',
      timestamp: Date.now(),
      version: 1,
      operation: 'UPDATE',
      metadata: { someOtherData: true },
    };

    walStore.entries.push({
      logSequenceNumber: 1,
      timestamp: Date.now(),
      checksum: 'test',
      data: genericUpdate,
    });

    // Also add a real resource entry
    const writer = walStore.createWriter();
    const registry1 = createRegistry(writer);
    await registry1.start();
    await registry1.createResource(
      makeResourceMetadata({
        resourceId: 'real-resource',
        resourceType: 'test-resource',
        applicationData: { real: true },
      })
    );
    await registry1.stop();

    // Recover
    const registry2 = createRegistry();
    await registry2.start();
    const result = await registry2.recoverFromWAL(walStore.createReader());

    // Only the CREATE entry should count as replayed (not the generic one)
    expect(result.entriesReplayed).toBe(1);
    expect(registry2.getResource('real-resource')).not.toBeNull();

    await registry2.stop();
  });
});
