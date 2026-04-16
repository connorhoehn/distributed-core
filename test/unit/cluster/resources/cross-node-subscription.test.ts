import { EventEmitter } from 'events';
import { ResourceSubscriptionManager, SubscriptionEvent } from '../../../../src/resources/management/ResourceSubscriptionManager';
import { ResourceDistributionEngine } from '../../../../src/resources/distribution/ResourceDistributionEngine';
import { ResourceRegistry } from '../../../../src/resources/core/ResourceRegistry';
import { ResourceMetadata, ResourceState, ResourceHealth } from '../../../../src/resources/types';
import { ResourceOperation } from '../../../../src/resources/core/ResourceOperation';

// --- Mocks ---

function createMockClusterNode(nodeId: string): any {
  const emitter = new EventEmitter();
  return {
    localNodeId: nodeId,
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    getAliveMembers: () => [],
    sendCustomMessage: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockResourceRegistry(): any {
  const emitter = new EventEmitter();
  return {
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    getResource: jest.fn().mockResolvedValue(null),
    createRemoteResource: jest.fn().mockResolvedValue(undefined),
    updateResource: jest.fn().mockResolvedValue(undefined),
    removeResource: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockVectorClock(nodeId: string): ResourceOperation['vectorClock'] {
  return {
    nodeId,
    vector: new Map([[nodeId, 1]]),
    increment() { return this; },
    compare() { return 0; },
    merge() { return this; },
  };
}

function createResourceMetadata(overrides: Partial<ResourceMetadata> = {}): ResourceMetadata {
  return {
    id: 'res-1',
    resourceId: 'res-1',
    type: 'compute',
    resourceType: 'compute',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    nodeId: 'node-a',
    state: ResourceState.ACTIVE,
    health: ResourceHealth.HEALTHY,
    ...overrides,
  };
}

function createResourceOperation(
  resource: ResourceMetadata,
  type: ResourceOperation['type'] = 'UPDATE',
  originNodeId = 'node-a'
): ResourceOperation {
  return {
    opId: `op-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    resourceId: resource.resourceId,
    type,
    version: 1,
    timestamp: Date.now(),
    originNodeId,
    payload: resource,
    vectorClock: createMockVectorClock(originNodeId),
    correlationId: `corr-${Date.now()}`,
    leaseTerm: 1,
  };
}

// --- Tests ---

describe('Cross-node subscription notification', () => {
  let subscriptionManager: ResourceSubscriptionManager;
  let distributionEngine: ResourceDistributionEngine;
  let mockRegistry: any;
  let mockClusterNodeB: any;

  beforeEach(() => {
    mockRegistry = createMockResourceRegistry();
    mockClusterNodeB = createMockClusterNode('node-b');

    // Create a real distribution engine (Node B's engine) so we can emit events on it
    distributionEngine = new ResourceDistributionEngine(
      mockRegistry,
      mockClusterNodeB
    );

    // Create subscription manager on Node B, wired to the distribution engine
    subscriptionManager = new ResourceSubscriptionManager(
      mockRegistry,
      mockClusterNodeB,
      {
        maxInactiveTime: 300000,
        cleanupInterval: 600000, // long interval so cleanup doesn't interfere
        distributionEngine,
      }
    );
  });

  afterEach(() => {
    subscriptionManager.destroy();
    distributionEngine.removeAllListeners();
  });

  test('local subscription receives notification when remote operation arrives via distribution engine', async () => {
    // 1. Create a subscription on Node B filtering for 'compute' resources
    const subId = await subscriptionManager.subscribe('client-1', {
      resourceTypes: ['compute'],
    });
    expect(subId).toBeDefined();

    // 2. Set up a listener for subscription events
    const receivedEvents: SubscriptionEvent[] = [];
    subscriptionManager.on(`subscription:${subId}`, (event: SubscriptionEvent) => {
      receivedEvents.push(event);
    });

    // 3. Simulate an incoming operation from Node A (as the distribution engine would emit)
    const resource = createResourceMetadata({
      resourceId: 'remote-res-1',
      resourceType: 'compute',
      nodeId: 'node-a',
    });
    const operation = createResourceOperation(resource, 'UPDATE', 'node-a');

    // Directly emit the event the distribution engine fires after processIncomingOperation
    distributionEngine.emit('remote-resource-operation', operation);

    // 4. Verify the subscription callback fired
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].eventType).toBe('resource:updated');
    expect(receivedEvents[0].resource.resourceId).toBe('remote-res-1');
    expect(receivedEvents[0].subscriptionId).toBe(subId);
  });

  test('subscription with non-matching filter does NOT receive remote operation', async () => {
    // Subscribe for 'storage' resources only
    const subId = await subscriptionManager.subscribe('client-2', {
      resourceTypes: ['storage'],
    });

    const receivedEvents: SubscriptionEvent[] = [];
    subscriptionManager.on(`subscription:${subId}`, (event: SubscriptionEvent) => {
      receivedEvents.push(event);
    });

    // Emit a 'compute' resource operation — should not match
    const resource = createResourceMetadata({
      resourceId: 'remote-res-2',
      resourceType: 'compute',
      nodeId: 'node-a',
    });
    const operation = createResourceOperation(resource, 'UPDATE', 'node-a');
    distributionEngine.emit('remote-resource-operation', operation);

    expect(receivedEvents).toHaveLength(0);
  });

  test('CREATE operation maps to resource:created event type', async () => {
    const subId = await subscriptionManager.subscribe('client-3', {
      resourceTypes: ['compute'],
    });

    const receivedEvents: SubscriptionEvent[] = [];
    subscriptionManager.on(`subscription:${subId}`, (event: SubscriptionEvent) => {
      receivedEvents.push(event);
    });

    const resource = createResourceMetadata({ resourceId: 'remote-res-3', resourceType: 'compute' });
    const operation = createResourceOperation(resource, 'CREATE', 'node-a');
    distributionEngine.emit('remote-resource-operation', operation);

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].eventType).toBe('resource:created');
  });

  test('DELETE operation maps to resource:destroyed event type', async () => {
    const subId = await subscriptionManager.subscribe('client-4', {
      resourceTypes: ['compute'],
    });

    const receivedEvents: SubscriptionEvent[] = [];
    subscriptionManager.on(`subscription:${subId}`, (event: SubscriptionEvent) => {
      receivedEvents.push(event);
    });

    const resource = createResourceMetadata({ resourceId: 'remote-res-4', resourceType: 'compute' });
    const operation = createResourceOperation(resource, 'DELETE', 'node-a');
    distributionEngine.emit('remote-resource-operation', operation);

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].eventType).toBe('resource:destroyed');
  });

  test('multiple subscriptions all receive matching remote operations', async () => {
    const subId1 = await subscriptionManager.subscribe('client-5', {
      resourceTypes: ['compute'],
    });
    const subId2 = await subscriptionManager.subscribe('client-6', {
      resourceTypes: ['compute'],
    });

    const events1: SubscriptionEvent[] = [];
    const events2: SubscriptionEvent[] = [];
    subscriptionManager.on(`subscription:${subId1}`, (e: SubscriptionEvent) => events1.push(e));
    subscriptionManager.on(`subscription:${subId2}`, (e: SubscriptionEvent) => events2.push(e));

    const resource = createResourceMetadata({ resourceId: 'remote-res-5', resourceType: 'compute' });
    const operation = createResourceOperation(resource, 'UPDATE', 'node-a');
    distributionEngine.emit('remote-resource-operation', operation);

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
  });

  test('cancelled subscription does NOT receive remote operations', async () => {
    const subId = await subscriptionManager.subscribe('client-7', {
      resourceTypes: ['compute'],
    });

    const receivedEvents: SubscriptionEvent[] = [];
    subscriptionManager.on(`subscription:${subId}`, (event: SubscriptionEvent) => {
      receivedEvents.push(event);
    });

    // Cancel the subscription
    await subscriptionManager.unsubscribe(subId);

    const resource = createResourceMetadata({ resourceId: 'remote-res-6', resourceType: 'compute' });
    const operation = createResourceOperation(resource, 'UPDATE', 'node-a');
    distributionEngine.emit('remote-resource-operation', operation);

    expect(receivedEvents).toHaveLength(0);
  });

  test('connectDistributionEngine wires up listener after construction', async () => {
    // Create a subscription manager WITHOUT a distribution engine
    const managerNoEngine = new ResourceSubscriptionManager(
      mockRegistry,
      mockClusterNodeB,
      { cleanupInterval: 600000 }
    );

    const subId = await managerNoEngine.subscribe('client-8', {
      resourceTypes: ['compute'],
    });

    const receivedEvents: SubscriptionEvent[] = [];
    managerNoEngine.on(`subscription:${subId}`, (event: SubscriptionEvent) => {
      receivedEvents.push(event);
    });

    // Emit on the distribution engine — should NOT be received yet
    const resource = createResourceMetadata({ resourceId: 'remote-res-7', resourceType: 'compute' });
    const operation = createResourceOperation(resource, 'UPDATE', 'node-a');
    distributionEngine.emit('remote-resource-operation', operation);
    expect(receivedEvents).toHaveLength(0);

    // Now connect the distribution engine
    managerNoEngine.connectDistributionEngine(distributionEngine);

    // Emit again — should be received now
    distributionEngine.emit('remote-resource-operation', operation);
    expect(receivedEvents).toHaveLength(1);

    managerNoEngine.destroy();
  });

  test('subscription:event is also emitted for remote operations', async () => {
    await subscriptionManager.subscribe('client-9', {
      resourceTypes: ['compute'],
    });

    const globalEvents: SubscriptionEvent[] = [];
    subscriptionManager.on('subscription:event', (event: SubscriptionEvent) => {
      globalEvents.push(event);
    });

    const resource = createResourceMetadata({ resourceId: 'remote-res-8', resourceType: 'compute' });
    const operation = createResourceOperation(resource, 'UPDATE', 'node-a');
    distributionEngine.emit('remote-resource-operation', operation);

    expect(globalEvents).toHaveLength(1);
    expect(globalEvents[0].eventType).toBe('resource:updated');
  });

  test('resourceId filter matches remote operations', async () => {
    const subId = await subscriptionManager.subscribe('client-10', {
      resourceIds: ['specific-res'],
    });

    const receivedEvents: SubscriptionEvent[] = [];
    subscriptionManager.on(`subscription:${subId}`, (e: SubscriptionEvent) => receivedEvents.push(e));

    // Non-matching resourceId
    const resource1 = createResourceMetadata({ resourceId: 'other-res', resourceType: 'compute' });
    distributionEngine.emit('remote-resource-operation', createResourceOperation(resource1, 'UPDATE', 'node-a'));
    expect(receivedEvents).toHaveLength(0);

    // Matching resourceId
    const resource2 = createResourceMetadata({ resourceId: 'specific-res', resourceType: 'compute' });
    distributionEngine.emit('remote-resource-operation', createResourceOperation(resource2, 'UPDATE', 'node-a'));
    expect(receivedEvents).toHaveLength(1);
  });
});
