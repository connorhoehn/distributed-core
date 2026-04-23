import { EventEmitter } from 'events';
import { ClusterCompactionBridge } from '../../../src/persistence/compaction/ClusterCompactionBridge';
import { CompactionCoordinator } from '../../../src/persistence/compaction/CompactionCoordinator';

describe('ClusterCompactionBridge integration', () => {
  it('triggers compaction on member-joined and member-left events', async () => {
    jest.useFakeTimers();
    const cluster = new EventEmitter();
    const coordinator = {
      triggerCompactionCheck: jest.fn().mockResolvedValue(null),
    } as unknown as CompactionCoordinator;
    const bridge = new ClusterCompactionBridge(cluster, coordinator, { debounceMs: 100 });

    bridge.attach();

    cluster.emit('member-joined', { id: 'node-1' });
    await jest.advanceTimersByTimeAsync(200);
    expect(coordinator.triggerCompactionCheck).toHaveBeenCalledTimes(1);

    cluster.emit('member-left', 'node-1');
    await jest.advanceTimersByTimeAsync(200);
    expect(coordinator.triggerCompactionCheck).toHaveBeenCalledTimes(2);

    bridge.detach();
    cluster.emit('member-joined', { id: 'node-2' });
    await jest.advanceTimersByTimeAsync(200);
    expect(coordinator.triggerCompactionCheck).toHaveBeenCalledTimes(2); // no more calls

    jest.useRealTimers();
  });

  it('coalesces rapid membership churn into a single compaction check', async () => {
    jest.useFakeTimers();
    const cluster = new EventEmitter();
    const coordinator = {
      triggerCompactionCheck: jest.fn().mockResolvedValue(null),
    } as unknown as CompactionCoordinator;
    const bridge = new ClusterCompactionBridge(cluster, coordinator, { debounceMs: 100 });

    bridge.attach();

    // Simulate rapid churn: multiple joins and leaves within the debounce window
    cluster.emit('member-joined', { id: 'node-1' });
    cluster.emit('member-left', 'node-1');
    cluster.emit('member-joined', { id: 'node-2' });
    cluster.emit('member-left', 'node-2');
    cluster.emit('member-joined', { id: 'node-3' });

    await jest.advanceTimersByTimeAsync(200);

    // All five events coalesce into a single call
    expect(coordinator.triggerCompactionCheck).toHaveBeenCalledTimes(1);

    bridge.detach();
    jest.useRealTimers();
  });

  it('does not trigger membership-updated by default', async () => {
    jest.useFakeTimers();
    const cluster = new EventEmitter();
    const coordinator = {
      triggerCompactionCheck: jest.fn().mockResolvedValue(null),
    } as unknown as CompactionCoordinator;
    const bridge = new ClusterCompactionBridge(cluster, coordinator, { debounceMs: 100 });

    bridge.attach();
    cluster.emit('membership-updated', new Map());
    await jest.advanceTimersByTimeAsync(200);
    expect(coordinator.triggerCompactionCheck).not.toHaveBeenCalled();

    bridge.detach();
    jest.useRealTimers();
  });

  it('triggers membership-updated when opt-in flag is set', async () => {
    jest.useFakeTimers();
    const cluster = new EventEmitter();
    const coordinator = {
      triggerCompactionCheck: jest.fn().mockResolvedValue(null),
    } as unknown as CompactionCoordinator;
    const bridge = new ClusterCompactionBridge(cluster, coordinator, {
      debounceMs: 100,
      triggerOnMembershipUpdate: true,
    });

    bridge.attach();
    cluster.emit('membership-updated', new Map());
    await jest.advanceTimersByTimeAsync(200);
    expect(coordinator.triggerCompactionCheck).toHaveBeenCalledTimes(1);

    bridge.detach();
    jest.useRealTimers();
  });
});
