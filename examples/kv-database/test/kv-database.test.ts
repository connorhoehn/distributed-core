import {
  createClusterNode,
  ClusterNodeConfig,
  RangeCoordinator,
} from 'distributed-core';
import { KVHandler, responseStore, rangeStores } from '../src/kv-handler';
import { KVClient } from '../src/kv-client';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeNode(id: string): RangeCoordinator {
  const config: ClusterNodeConfig = {
    ringId: 'test-kv-ring',
    rangeHandler: new KVHandler(),
    coordinator: 'in-memory',
    transport: 'in-memory',
    nodeId: id,
    coordinatorConfig: {
      testMode: true,
      heartbeatIntervalMs: 100,
      leaseRenewalIntervalMs: 200,
      leaseTimeoutMs: 1000,
    },
    logging: {
      enableFrameworkLogs: false,
      enableCoordinatorLogs: false,
    },
  };
  return createClusterNode(config);
}

describe('kv-database example', () => {
  let nodes: RangeCoordinator[];

  beforeEach(async () => {
    // Clear shared state between tests
    responseStore.clear();
    rangeStores.clear();

    nodes = [makeNode('test-0'), makeNode('test-1'), makeNode('test-2')];
    for (const n of nodes) {
      await n.start();
    }
    // Allow range acquisition
    await sleep(600);
  });

  afterEach(async () => {
    for (const n of nodes) {
      try {
        await n.stop();
      } catch {
        // node may already be stopped
      }
    }
  });

  it('SET then GET returns the correct value', async () => {
    const client = new KVClient(nodes);
    await client.set('greeting', 'hello');
    const value = await client.get('greeting');
    expect(value).toBe('hello');
  });

  it('GET on non-existent key returns null', async () => {
    const client = new KVClient(nodes);
    const value = await client.get('does-not-exist');
    expect(value).toBeNull();
  });

  it('DELETE removes a key', async () => {
    const client = new KVClient(nodes);
    await client.set('temp', 'data');
    expect(await client.get('temp')).toBe('data');

    const deleted = await client.delete('temp');
    expect(deleted).toBe(true);
    expect(await client.get('temp')).toBeNull();
  });

  it('DELETE on non-existent key returns false', async () => {
    const client = new KVClient(nodes);
    const deleted = await client.delete('ghost');
    expect(deleted).toBe(false);
  });

  it('keys survive on ranges still owned after a node departs', async () => {
    const client = new KVClient(nodes);

    // Write a batch of keys so several ranges are populated
    const keys = Array.from({ length: 20 }, (_, i) => `key-${i}`);
    for (const k of keys) {
      await client.set(k, `value-${k}`);
    }

    // Stop the last node
    await nodes[2].stop();
    await sleep(300);

    // Build a new client with only the surviving nodes
    const surviving = nodes.slice(0, 2);
    const client2 = new KVClient(surviving);

    // At least some keys should still be readable (those whose range is on a surviving node)
    let readable = 0;
    for (const k of keys) {
      try {
        const val = await client2.get(k);
        if (val !== null) readable++;
      } catch {
        // range unavailable
      }
    }
    // Expect that a non-trivial portion of keys survived (depends on range distribution)
    expect(readable).toBeGreaterThan(0);
  });
});
