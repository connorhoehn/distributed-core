import * as http from 'http';
import { HealthServer } from '../../../src/common/HealthServer';

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${path}`, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      })
      .on('error', reject);
  });
}

describe('HealthServer', () => {
  let server: HealthServer;
  let port: number;

  const healthProvider = () => ({
    status: 'ok',
    nodeId: 'test-node',
    uptime: 12345,
    memberCount: 3,
  });

  const statusProvider = () => ({
    nodeId: 'test-node',
    members: [
      { id: 'node-1', status: 'alive' },
      { id: 'node-2', status: 'alive' },
      { id: 'node-3', status: 'suspect' },
    ],
    clusterHealth: { healthy: true },
  });

  const metricsProvider = () => ({
    nodeId: 'test-node',
    isStarted: true,
    messagesRouted: 42,
  });

  beforeEach(async () => {
    server = new HealthServer(0, healthProvider, statusProvider, metricsProvider);
    await server.start();
    port = server.getPort();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('responds to GET /health with health info', async () => {
    const res = await get(port, '/health');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toEqual({
      status: 'ok',
      nodeId: 'test-node',
      uptime: 12345,
      memberCount: 3,
    });
  });

  it('responds to GET /status with membership info', async () => {
    const res = await get(port, '/status');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.nodeId).toBe('test-node');
    expect(data.members).toHaveLength(3);
    expect(data.members[2]).toEqual({ id: 'node-3', status: 'suspect' });
    expect(data.clusterHealth).toEqual({ healthy: true });
  });

  it('responds to GET /metrics with metrics info', async () => {
    const res = await get(port, '/metrics');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.nodeId).toBe('test-node');
    expect(data.messagesRouted).toBe(42);
  });

  it('returns 404 for unknown paths', async () => {
    const res = await get(port, '/unknown');
    expect(res.status).toBe(404);
  });

  it('can be stopped and restarted', async () => {
    await server.stop();
    server = new HealthServer(0, healthProvider, statusProvider, metricsProvider);
    await server.start();
    port = server.getPort();
    const res = await get(port, '/health');
    expect(res.status).toBe(200);
  });
});
