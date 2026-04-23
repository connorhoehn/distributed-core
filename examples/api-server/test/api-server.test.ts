import { Node, StateStore } from 'distributed-core';
import { registerApiHandlers, sendApiRequest, apiResponses } from '../src/api-handler';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('api-server example', () => {
  let nodes: Node[];
  let stores: StateStore[];

  beforeEach(async () => {
    apiResponses.clear();
    nodes = [];
    stores = [];

    for (let i = 0; i < 2; i++) {
      const node = new Node({
        id: `test-api-${i}`,
        clusterId: 'test-cluster',
        service: 'api-test',
        seedNodes: nodes.map((n) => n.id),
        lifecycle: {
          shutdownTimeout: 500,
          drainTimeout: 200,
          maxShutdownWait: 500,
        },
      });
      const store = new StateStore();
      registerApiHandlers(node, store);
      await node.start();
      nodes.push(node);
      stores.push(store);
    }
    await sleep(300);
  }, 15000);

  afterEach(async () => {
    for (const n of nodes) {
      try { await n.stop(); } catch { /* already stopped */ }
    }
  }, 15000);

  it('GET:/health returns cluster health', () => {
    const resp = sendApiRequest(nodes[0], 'GET:/health');
    expect(resp).toBeDefined();
    expect(resp.status).toBe('ok');
    expect(resp.nodeId).toBe('test-api-0');
    expect(typeof resp.cluster.totalNodes).toBe('number');
  });

  it('GET:/members returns member list', () => {
    const resp = sendApiRequest(nodes[0], 'GET:/members');
    expect(resp).toBeDefined();
    expect(resp.nodeId).toBe('test-api-0');
    expect(typeof resp.count).toBe('number');
  });

  it('POST:/data + GET:/data round-trips a value', () => {
    sendApiRequest(nodes[0], 'POST:/data', { key: 'k1', value: 'v1' });
    const resp = sendApiRequest(nodes[0], 'GET:/data', { key: 'k1' });
    expect(resp.key).toBe('k1');
    expect(resp.value).toBe('v1');
  });

  it('GET:/data for missing key returns null', () => {
    const resp = sendApiRequest(nodes[0], 'GET:/data', { key: 'missing' });
    expect(resp.value).toBeNull();
  });

  it('GET:/info returns node and topology info', () => {
    const resp = sendApiRequest(nodes[0], 'GET:/info');
    expect(resp).toBeDefined();
    expect(resp.nodeId).toBe('test-api-0');
    expect(resp.topology).toBeDefined();
  });
});
