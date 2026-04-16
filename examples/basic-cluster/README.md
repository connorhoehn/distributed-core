# Basic Cluster Example

A minimal 3-node cluster that demonstrates core distributed-core concepts:

- Creating nodes with `InMemoryAdapter` (no network setup required)
- Cluster formation via the gossip-based join protocol
- Membership propagation and convergence
- Sending custom messages between specific nodes
- Graceful shutdown

## Run

```bash
npm run example:basic
```

Or directly:

```bash
npx ts-node examples/basic-cluster/index.ts
```

## What it does

1. Creates 3 nodes. `node-0` acts as the seed; `node-1` and `node-2` join through it.
2. Starts all nodes and waits for gossip to propagate full membership.
3. Prints the cluster membership table from every node's perspective.
4. Sends a custom `"greeting"` message from `node-0` to `node-1` and logs receipt.
5. Shuts down all nodes gracefully.
