import { SharedStateManager } from '../../../../src/gateway/state/SharedStateManager';
import { SharedStateAdapter } from '../../../../src/gateway/state/types';
import { InMemorySnapshotVersionStore } from '../../../../src/persistence/snapshot/InMemorySnapshotVersionStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Simple string accumulator: state is a sorted list of tokens joined by ','
// Updates are individual tokens to append.
const stringAdapter: SharedStateAdapter<string, string> = {
  createState: () => '',
  applyUpdate: (state, update) => (state ? `${state},${update}` : update),
  serialize: (state) => state,
  deserialize: (raw) => raw as string,
  mergeUpdates: (updates) => [updates.join('+')],
};

function makeMockPubSub() {
  const handlers = new Map<string, (topic: string, payload: unknown) => void>();
  let subCounter = 0;
  return {
    subscribe: jest.fn((topic: string, handler: (t: string, p: unknown) => void) => {
      const id = `sub-${++subCounter}`;
      handlers.set(id, (t, p) => handler(t, p));
      // Store topic → id for easy retrieval in tests
      handlers.set(`${topic}::id`, () => {}) as any;
      return id;
    }),
    unsubscribe: jest.fn((id: string) => {
      handlers.delete(id);
    }),
    publish: jest.fn(async (topic: string, payload: unknown) => {
      // Simulate remote delivery by calling all handlers for this topic
      for (const [, handler] of handlers) {
        try { handler(topic, payload); } catch (_) {}
      }
    }),
    _handlers: handlers,
  };
}

function makeMockChannels() {
  return {
    joinChannel: jest.fn(),
    leaveChannel: jest.fn(),
    broadcastToChannel: jest.fn().mockResolvedValue(undefined),
  };
}

function makeMockPresence() {
  return {
    trackClient: jest.fn().mockReturnValue({ clientId: 'c', nodeId: 'n', metadata: {}, connectedAt: 0, lastSeen: 0 }),
    untrackClient: jest.fn().mockReturnValue(true),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SharedStateManager', () => {
  let snapshots: InMemorySnapshotVersionStore<string>;

  beforeEach(() => {
    jest.useFakeTimers();
    snapshots = new InMemorySnapshotVersionStore();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // subscribe
  // -------------------------------------------------------------------------

  describe('subscribe()', () => {
    it('returns initial empty state when no snapshot exists', async () => {
      const mgr = new SharedStateManager(stringAdapter);
      const state = await mgr.subscribe('client-1', 'ch-1');
      expect(state).toBe('');
    });

    it('hydrates state from snapshot store on first subscribe', async () => {
      await snapshots.store('ch-1', 'hydrated-state');
      const mgr = new SharedStateManager(stringAdapter, {}, { snapshots });

      const state = await mgr.subscribe('client-1', 'ch-1');
      expect(state).toBe('hydrated-state');
    });

    it('increments subscriberCount for the same channel', async () => {
      const mgr = new SharedStateManager(stringAdapter);
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.subscribe('client-2', 'ch-1');

      expect(mgr.getStats().activeSessions).toBe(1);
    });

    it('cancels a pending eviction when a new subscriber arrives', async () => {
      const mgr = new SharedStateManager(stringAdapter, { idleEvictionMs: 500 });

      await mgr.subscribe('client-1', 'ch-1');
      await mgr.unsubscribe('client-1', 'ch-1');
      expect(mgr.getStats().pendingEvictions).toBe(1);

      // New subscriber before eviction fires
      await mgr.subscribe('client-2', 'ch-1');
      expect(mgr.getStats().pendingEvictions).toBe(0);
      expect(mgr.getStats().activeSessions).toBe(1);
    });

    it('calls channels.joinChannel when dep is provided', async () => {
      const channels = makeMockChannels();
      const mgr = new SharedStateManager(stringAdapter, {}, { channels: channels as any });

      await mgr.subscribe('client-1', 'ch-1');
      expect(channels.joinChannel).toHaveBeenCalledWith('ch-1', 'client-1');
    });

    it('calls presence.trackClient only on first channel subscription', async () => {
      const presence = makeMockPresence();
      const mgr = new SharedStateManager(stringAdapter, {}, { presence: presence as any });

      await mgr.subscribe('client-1', 'ch-1');
      await mgr.subscribe('client-1', 'ch-2'); // second channel, same client
      expect(presence.trackClient).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // applyUpdate
  // -------------------------------------------------------------------------

  describe('applyUpdate()', () => {
    it('mutates session state via the adapter', async () => {
      const mgr = new SharedStateManager(stringAdapter);
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.applyUpdate('ch-1', 'hello');

      const snapshot = await mgr.getSnapshot('ch-1');
      expect(snapshot).toBe('hello');
    });

    it('accumulates multiple updates', async () => {
      const mgr = new SharedStateManager(stringAdapter);
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.applyUpdate('ch-1', 'a');
      await mgr.applyUpdate('ch-1', 'b');

      expect(await mgr.getSnapshot('ch-1')).toBe('a,b');
    });

    it('throws when the channel has no active session', async () => {
      const mgr = new SharedStateManager(stringAdapter);
      await expect(mgr.applyUpdate('no-session', 'x')).rejects.toThrow('no active session');
    });

    it('buffers updates in the coalescer', async () => {
      const mgr = new SharedStateManager(stringAdapter, { coalescingWindowMs: 50 });
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.applyUpdate('ch-1', 'a');

      expect(mgr.getStats().pendingCoalesce).toBe(1);
    });

    it('calls pubsub.publish for cross-node propagation', async () => {
      const pubsub = makeMockPubSub();
      const mgr = new SharedStateManager(stringAdapter, {}, { pubsub: pubsub as any });
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.applyUpdate('ch-1', 'msg');

      expect(pubsub.publish).toHaveBeenCalledWith('shared-state:ch-1', 'msg');
    });

    it('takes an auto snapshot every operationsBeforeCheckpoint ops', async () => {
      const storeSpy = jest.spyOn(snapshots, 'store');
      const mgr = new SharedStateManager(
        stringAdapter,
        { operationsBeforeCheckpoint: 3 },
        { snapshots }
      );
      await mgr.subscribe('client-1', 'ch-1');

      await mgr.applyUpdate('ch-1', 'a');
      await mgr.applyUpdate('ch-1', 'b');
      expect(storeSpy).not.toHaveBeenCalled();

      await mgr.applyUpdate('ch-1', 'c'); // 3rd op triggers immediate snapshot
      expect(storeSpy).toHaveBeenCalledWith('ch-1', 'a,b,c', { type: 'auto' });
    });
  });

  // -------------------------------------------------------------------------
  // getSnapshot
  // -------------------------------------------------------------------------

  describe('getSnapshot()', () => {
    it('returns null when no session and no snapshot', async () => {
      const mgr = new SharedStateManager(stringAdapter);
      expect(await mgr.getSnapshot('ch-1')).toBeNull();
    });

    it('returns live session state for active channels', async () => {
      const mgr = new SharedStateManager(stringAdapter);
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.applyUpdate('ch-1', 'live');

      expect(await mgr.getSnapshot('ch-1')).toBe('live');
    });

    it('falls back to snapshot store for inactive sessions', async () => {
      await snapshots.store('ch-1', 'persisted');
      const mgr = new SharedStateManager(stringAdapter, {}, { snapshots });

      // No subscribe → no active session
      expect(await mgr.getSnapshot('ch-1')).toBe('persisted');
    });
  });

  // -------------------------------------------------------------------------
  // unsubscribe
  // -------------------------------------------------------------------------

  describe('unsubscribe()', () => {
    it('is a no-op when client has no session', async () => {
      const mgr = new SharedStateManager(stringAdapter);
      await expect(mgr.unsubscribe('unknown', 'ch-1')).resolves.not.toThrow();
    });

    it('calls channels.leaveChannel', async () => {
      const channels = makeMockChannels();
      const mgr = new SharedStateManager(stringAdapter, {}, { channels: channels as any });
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.unsubscribe('client-1', 'ch-1');
      expect(channels.leaveChannel).toHaveBeenCalledWith('ch-1', 'client-1');
    });

    it('untracks presence when client leaves all channels', async () => {
      const presence = makeMockPresence();
      const mgr = new SharedStateManager(stringAdapter, {}, { presence: presence as any });
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.unsubscribe('client-1', 'ch-1');
      expect(presence.untrackClient).toHaveBeenCalledWith('client-1');
    });

    it('does NOT untrack presence while client is still in other channels', async () => {
      const presence = makeMockPresence();
      const mgr = new SharedStateManager(stringAdapter, {}, { presence: presence as any });
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.subscribe('client-1', 'ch-2');
      await mgr.unsubscribe('client-1', 'ch-1');
      expect(presence.untrackClient).not.toHaveBeenCalled();
    });

    it('schedules eviction when last subscriber leaves', async () => {
      const mgr = new SharedStateManager(stringAdapter, { idleEvictionMs: 1000 });
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.unsubscribe('client-1', 'ch-1');
      expect(mgr.getStats().pendingEvictions).toBe(1);
    });

    it('does not schedule eviction while other subscribers remain', async () => {
      const mgr = new SharedStateManager(stringAdapter);
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.subscribe('client-2', 'ch-1');
      await mgr.unsubscribe('client-1', 'ch-1');
      expect(mgr.getStats().pendingEvictions).toBe(0);
    });

    it('writes a checkpoint snapshot on last unsubscribe', async () => {
      const storeSpy = jest.spyOn(snapshots, 'store');
      const mgr = new SharedStateManager(stringAdapter, {}, { snapshots });
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.applyUpdate('ch-1', 'data');
      await mgr.unsubscribe('client-1', 'ch-1');
      expect(storeSpy).toHaveBeenCalledWith('ch-1', 'data', { type: 'checkpoint' });
    });
  });

  // -------------------------------------------------------------------------
  // onClientDisconnect
  // -------------------------------------------------------------------------

  describe('onClientDisconnect()', () => {
    it('unsubscribes the client from all channels', async () => {
      const channels = makeMockChannels();
      const mgr = new SharedStateManager(stringAdapter, {}, { channels: channels as any });
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.subscribe('client-1', 'ch-2');

      await mgr.onClientDisconnect('client-1');

      expect(channels.leaveChannel).toHaveBeenCalledWith('ch-1', 'client-1');
      expect(channels.leaveChannel).toHaveBeenCalledWith('ch-2', 'client-1');
    });

    it('is a no-op for unknown clients', async () => {
      const mgr = new SharedStateManager(stringAdapter);
      await expect(mgr.onClientDisconnect('ghost')).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // shutdown
  // -------------------------------------------------------------------------

  describe('shutdown()', () => {
    it('writes checkpoints for all active sessions', async () => {
      const storeSpy = jest.spyOn(snapshots, 'store');
      const mgr = new SharedStateManager(stringAdapter, {}, { snapshots });

      await mgr.subscribe('client-1', 'ch-1');
      await mgr.applyUpdate('ch-1', 'alive');
      await mgr.subscribe('client-2', 'ch-2');
      await mgr.applyUpdate('ch-2', 'alive2');

      await mgr.shutdown();

      expect(storeSpy).toHaveBeenCalledWith('ch-1', 'alive', { type: 'checkpoint' });
      expect(storeSpy).toHaveBeenCalledWith('ch-2', 'alive2', { type: 'checkpoint' });
    });

    it('clears all active sessions after shutdown', async () => {
      const mgr = new SharedStateManager(stringAdapter);
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.shutdown();
      expect(mgr.getStats().activeSessions).toBe(0);
    });

    it('cancels all pending evictions', async () => {
      const mgr = new SharedStateManager(stringAdapter, { idleEvictionMs: 5000 });
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.unsubscribe('client-1', 'ch-1');
      expect(mgr.getStats().pendingEvictions).toBe(1);

      await mgr.shutdown();
      expect(mgr.getStats().pendingEvictions).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // eviction
  // -------------------------------------------------------------------------

  describe('idle eviction', () => {
    it('evicts the session after the idle delay', async () => {
      const mgr = new SharedStateManager(stringAdapter, { idleEvictionMs: 500 });
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.unsubscribe('client-1', 'ch-1');

      expect(mgr.getStats().activeSessions).toBe(1); // still in memory
      await jest.advanceTimersByTimeAsync(500);
      expect(mgr.getStats().activeSessions).toBe(0); // evicted
    });

    it('does not evict a session that has regained subscribers', async () => {
      const mgr = new SharedStateManager(stringAdapter, { idleEvictionMs: 500 });
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.unsubscribe('client-1', 'ch-1');

      await jest.advanceTimersByTimeAsync(200);
      await mgr.subscribe('client-2', 'ch-1'); // arrives before eviction

      await jest.advanceTimersByTimeAsync(400); // past original eviction time
      expect(mgr.getStats().activeSessions).toBe(1); // still alive
    });
  });

  // -------------------------------------------------------------------------
  // snapshot debounce
  // -------------------------------------------------------------------------

  describe('snapshot debounce', () => {
    it('takes a debounced snapshot after inactivity', async () => {
      const storeSpy = jest.spyOn(snapshots, 'store');
      const mgr = new SharedStateManager(
        stringAdapter,
        { snapshotDebounceMs: 200, operationsBeforeCheckpoint: 1000 },
        { snapshots }
      );
      await mgr.subscribe('client-1', 'ch-1');
      await mgr.applyUpdate('ch-1', 'x');

      expect(storeSpy).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(200);
      expect(storeSpy).toHaveBeenCalledWith('ch-1', 'x', { type: 'auto' });
    });
  });

  // -------------------------------------------------------------------------
  // getStats
  // -------------------------------------------------------------------------

  describe('getStats()', () => {
    it('reports zero stats on a fresh manager', () => {
      const mgr = new SharedStateManager(stringAdapter);
      expect(mgr.getStats()).toEqual({ activeSessions: 0, pendingCoalesce: 0, pendingEvictions: 0 });
    });

    it('tracks active sessions', async () => {
      const mgr = new SharedStateManager(stringAdapter);
      await mgr.subscribe('c1', 'ch-1');
      await mgr.subscribe('c2', 'ch-2');
      expect(mgr.getStats().activeSessions).toBe(2);
    });

    it('tracks pending evictions', async () => {
      const mgr = new SharedStateManager(stringAdapter, { idleEvictionMs: 9999 });
      await mgr.subscribe('c1', 'ch-1');
      await mgr.unsubscribe('c1', 'ch-1');
      expect(mgr.getStats().pendingEvictions).toBe(1);
    });
  });
});
