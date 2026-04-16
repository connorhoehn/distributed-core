import { EventEmitter } from 'events';
import { ResourceSubscriptionManager, SubscriptionEvent } from '../../../src/resources/management/ResourceSubscriptionManager';
import { ResourceMetadata, ResourceState, ResourceHealth } from '../../../src/resources/types';

/**
 * Cross-cluster subscription notifications
 *
 * Flow under test:
 *   1. ResourceSubscriptionManager subscribes to resource type "counter"
 *   2. ResourceDistributionEngine receives a remote operation for a "counter" resource
 *      and emits on ResourceRegistry ('resource:created' / 'resource:updated')
 *   3. ResourceSubscriptionManager's internal handler fires and notifies matching subscriptions
 *
 * We simulate step 2 by emitting directly on the mock ResourceRegistry.
 */

function makeResource(overrides: Partial<ResourceMetadata> = {}): ResourceMetadata {
  return {
    id: 'res-1',
    resourceId: 'counter-1',
    type: 'counter',
    resourceType: 'counter',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    timestamp: Date.now(),
    nodeId: 'remote-node-1',
    state: ResourceState.ACTIVE,
    health: ResourceHealth.HEALTHY,
    ...overrides,
  };
}

function buildMocks() {
  const mockRegistry = new EventEmitter();
  const mockClusterManager = Object.assign(new EventEmitter(), {
    localNodeId: 'local-node-1',
    getAliveMembers: jest.fn().mockReturnValue([]),
    sendCustomMessage: jest.fn().mockResolvedValue(undefined),
  });

  return { mockRegistry, mockClusterManager };
}

describe('Cross-cluster subscription notifications', () => {
  let manager: ResourceSubscriptionManager;
  let mockRegistry: EventEmitter;
  let mockClusterManager: ReturnType<typeof buildMocks>['mockClusterManager'];

  beforeEach(() => {
    const mocks = buildMocks();
    mockRegistry = mocks.mockRegistry;
    mockClusterManager = mocks.mockClusterManager;

    manager = new ResourceSubscriptionManager(
      mockRegistry as any,
      mockClusterManager as any,
      { cleanupInterval: 999_999_999 }, // effectively disable cleanup timer
    );
  });

  afterEach(() => {
    manager.destroy();
  });

  test('subscription callback fires when a matching remote resource is created', async () => {
    const callback = jest.fn();
    const subId = await manager.subscribe('client-1', { resourceTypes: ['counter'] });

    manager.on(`subscription:${subId}`, callback);

    // Simulate ResourceDistributionEngine emitting on ResourceRegistry
    const resource = makeResource();
    mockRegistry.emit('resource:created', resource);

    expect(callback).toHaveBeenCalledTimes(1);
    const event: SubscriptionEvent = callback.mock.calls[0][0];
    expect(event.eventType).toBe('resource:created');
    expect(event.resource.resourceId).toBe('counter-1');
    expect(event.subscriptionId).toBe(subId);
  });

  test('subscription callback fires for resource:updated events', async () => {
    const callback = jest.fn();
    const subId = await manager.subscribe('client-1', { resourceTypes: ['counter'] });

    manager.on(`subscription:${subId}`, callback);

    const previous = makeResource({ state: ResourceState.INACTIVE });
    const updated = makeResource({ state: ResourceState.ACTIVE });
    mockRegistry.emit('resource:updated', updated, previous);

    // Should receive both 'resource:updated' and 'resource:state-changed' since state differs
    expect(callback).toHaveBeenCalledTimes(2);
    const eventTypes = callback.mock.calls.map((c: any[]) => c[0].eventType);
    expect(eventTypes).toContain('resource:updated');
    expect(eventTypes).toContain('resource:state-changed');
  });

  test('subscription for type "counter" does NOT fire for type "timer" operations', async () => {
    const callback = jest.fn();
    const subId = await manager.subscribe('client-1', { resourceTypes: ['counter'] });

    manager.on(`subscription:${subId}`, callback);

    const timerResource = makeResource({ resourceType: 'timer', type: 'timer', resourceId: 'timer-1' });
    mockRegistry.emit('resource:created', timerResource);

    expect(callback).not.toHaveBeenCalled();
  });

  test('after unsubscribe, callback should not fire', async () => {
    const callback = jest.fn();
    const subId = await manager.subscribe('client-1', { resourceTypes: ['counter'] });

    manager.on(`subscription:${subId}`, callback);

    // Unsubscribe
    const result = await manager.unsubscribe(subId);
    expect(result).toBe(true);

    // Emit resource event after unsubscribe
    const resource = makeResource();
    mockRegistry.emit('resource:created', resource);

    expect(callback).not.toHaveBeenCalled();
  });

  test('global subscription:event fires for matching resources', async () => {
    const globalCallback = jest.fn();
    await manager.subscribe('client-1', { resourceTypes: ['counter'] });

    manager.on('subscription:event', globalCallback);

    const resource = makeResource();
    mockRegistry.emit('resource:created', resource);

    expect(globalCallback).toHaveBeenCalledTimes(1);
    expect(globalCallback.mock.calls[0][0].eventType).toBe('resource:created');
  });

  test('multiple subscriptions for the same type each receive the event', async () => {
    const cb1 = jest.fn();
    const cb2 = jest.fn();

    const subId1 = await manager.subscribe('client-1', { resourceTypes: ['counter'] });
    const subId2 = await manager.subscribe('client-2', { resourceTypes: ['counter'] });

    manager.on(`subscription:${subId1}`, cb1);
    manager.on(`subscription:${subId2}`, cb2);

    mockRegistry.emit('resource:created', makeResource());

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});
