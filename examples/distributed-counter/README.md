# Distributed Counter Example

Demonstrates the distributed-core resource system by creating a shared counter resource across a 3-node in-memory cluster.

## What it does

1. Creates 3 nodes using `InMemoryAdapter` (no real networking required)
2. Each node has its own `ResourceRegistry` and joins a cluster via `ClusterManager`
3. Registers a "counter" resource type on all nodes
4. Creates a counter resource on node-0 with initial value 0
5. Distributes the counter to node-1 and node-2 via `StateDelta` messages
6. Increments the counter from node-1 and distributes the update
7. Increments the counter from node-2 and distributes the update
8. Shows the final counter value (2) is consistent across all nodes
9. Gracefully shuts down

## Run

```bash
npx ts-node examples/distributed-counter/index.ts
# or
npm run example:counter
```

## Architecture notes

This example uses **manual distribution wiring** rather than `ResourceDistributionEngine` directly. This is because the engine currently has a feedback loop where `resource:created` events trigger distribution, which triggers `resource:created` on the receiving node, which triggers distribution again. The manual wiring pattern (also used by the e2e tests) avoids this by:

- Creating `ResourceRegistry` instances without a `clusterManager` reference (prevents the registry's own cluster event propagation)
- Wiring `transport.onMessage` handlers that listen for `resource:delta` messages and apply them to the local registry via `createRemoteResource` / `updateResource`
- Using `StateDeltaManager.generateResourceDelta` + `ClusterManager.sendCustomMessage` to push changes to peers

Once the feedback loop fix lands, the example can be simplified to use `ResourceDistributionEngine` directly.

## Key APIs demonstrated

| API | Purpose |
|-----|---------|
| `ResourceRegistry.registerResourceType()` | Register a resource type definition |
| `ResourceRegistry.createResource()` | Create a new resource locally |
| `ResourceRegistry.updateResource()` | Update an existing resource |
| `ResourceRegistry.getResource()` | Read a resource by ID |
| `ResourceRegistry.createRemoteResource()` | Add a resource received from another node |
| `StateDeltaManager.generateResourceDelta()` | Generate a delta for cluster distribution |
| `ClusterManager.sendCustomMessage()` | Send a custom message to specific cluster nodes |
