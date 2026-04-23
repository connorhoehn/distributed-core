import { Node } from 'distributed-core';
import { AgentHandler } from '../src/agent-handler';
import { renderDashboard } from '../src/dashboard';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('management-agent example', () => {
  let nodes: Node[];
  let agent: AgentHandler;

  beforeEach(async () => {
    nodes = [];
    for (let i = 0; i < 2; i++) {
      const node = new Node({
        id: `test-mgmt-${i}`,
        clusterId: 'test-mgmt-cluster',
        service: 'mgmt-test',
        seedNodes: nodes.map((n) => n.id),
        lifecycle: {
          shutdownTimeout: 500,
          drainTimeout: 200,
          maxShutdownWait: 500,
        },
      });
      await node.start();
      nodes.push(node);
    }
    await sleep(300);
    agent = new AgentHandler(nodes);
    await agent.start();
  }, 15000);

  afterEach(async () => {
    await agent.stop();
    for (const n of nodes) {
      try { await n.stop(); } catch { /* already stopped */ }
    }
  }, 15000);

  it('collects a cluster snapshot', async () => {
    const snap = await agent.collectSnapshot();
    expect(snap.timestamp).toBeGreaterThan(0);
    expect(snap.nodes).toHaveLength(2);
    expect(snap.nodes[0].isRunning).toBe(true);
    expect(snap.systemHealth).toBeDefined();
    expect(snap.metrics).toBeDefined();
  });

  it('renders a dashboard without errors', async () => {
    const snap = await agent.collectSnapshot();
    const output = renderDashboard(snap);
    expect(output).toContain('CLUSTER MANAGEMENT DASHBOARD');
    expect(output).toContain('test-mgmt-0');
    expect(output).toContain('test-mgmt-1');
    expect(output).toContain('SYSTEM HEALTH');
  });

  it('chaos injection activates and deactivates', async () => {
    expect(agent.getChaosStats().activeScenariosCount).toBe(0);

    await agent.injectLatency(100);
    const snap = await agent.collectSnapshot();
    expect(snap.chaosActive).toBe(true);
    expect(snap.activeScenarios).toContain('network-latency');

    await agent.stopChaos();
    const snap2 = await agent.collectSnapshot();
    expect(snap2.chaosActive).toBe(false);
  });

  it('network partition chaos can be injected', async () => {
    await agent.injectPartition(['test-mgmt-0']);
    const snap = await agent.collectSnapshot();
    expect(snap.activeScenarios).toContain('network-partition');

    await agent.stopChaos();
    expect(agent.getChaosStats().activeScenariosCount).toBe(0);
  });

  it('diagnostic tool reports system health', async () => {
    const diag = agent.getDiagnosticTool();
    const health = await diag.checkSystemHealth();
    expect(health.status).toBeDefined();
    expect(['healthy', 'degraded', 'unhealthy']).toContain(health.status);
  });
});
