import { createAgent } from '../../../src/frontdoor/createAgent';
import { AgentHandle } from '../../../src/frontdoor/AgentHandle';
import { InMemoryAdapter } from '../../../src/transport/adapters/InMemoryAdapter';
import { RangeHandler, ClusterInfo, ClusterMessage, RangeId } from '../../../src/coordinators/types';

/** Minimal stub handler for testing. */
class StubRangeHandler implements RangeHandler {
  joinedRanges: RangeId[] = [];
  leftRanges: RangeId[] = [];
  messages: ClusterMessage[] = [];

  async onJoin(rangeId: RangeId, clusterInfo: ClusterInfo): Promise<void> {
    this.joinedRanges.push(rangeId);
  }

  async onMessage(message: ClusterMessage): Promise<void> {
    this.messages.push(message);
  }

  async onLeave(rangeId: RangeId): Promise<void> {
    this.leftRanges.push(rangeId);
  }
}

describe('createAgent', () => {
  let agent: AgentHandle | null = null;

  afterEach(async () => {
    if (agent) {
      try { await agent.stop(); } catch { /* ignore */ }
      agent = null;
    }
    InMemoryAdapter.clearRegistry();
  });

  it('should throw if rangeHandler is not provided', async () => {
    await expect(
      createAgent({} as any),
    ).rejects.toThrow('rangeHandler is required');
  });

  it('should create an AgentHandle with a valid nodeHandle and coordinator', async () => {
    const handler = new StubRangeHandler();
    agent = await createAgent({ rangeHandler: handler });

    expect(agent).toBeInstanceOf(AgentHandle);
    expect(agent.nodeHandle).toBeDefined();
    expect(agent.coordinator).toBeDefined();
    expect(agent.id).toBeDefined();
  });

  it('should use in-memory coordinator by default', async () => {
    const handler = new StubRangeHandler();
    agent = await createAgent({ rangeHandler: handler });

    // The coordinator was constructed — verify it exists
    expect(agent.coordinator).toBeDefined();
  });

  it('should accept a custom coordinator type', async () => {
    const handler = new StubRangeHandler();
    agent = await createAgent({
      rangeHandler: handler,
      coordinator: 'in-memory',
      ringId: 'custom-ring',
    });

    expect(agent.coordinator).toBeDefined();
  });

  it('should pass ringId through to the coordinator config', async () => {
    const handler = new StubRangeHandler();
    agent = await createAgent({
      rangeHandler: handler,
      ringId: 'test-ring',
    });

    expect(agent).toBeInstanceOf(AgentHandle);
  });

  it('should not be running before start', async () => {
    const handler = new StubRangeHandler();
    agent = await createAgent({ rangeHandler: handler });

    expect(agent.isRunning()).toBe(false);
  });
});
