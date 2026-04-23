# distributed-core Examples

Four example applications demonstrating the core primitives of the distributed-core library.

## Prerequisites

Build the library from the repository root before running any example:

```bash
npm run build
```

## Examples

### 1. kv-database (Key-Value Store)

Demonstrates RangeCoordinator, RangeHandler, and StateStore for a distributed key-value database with consistent hash routing.

```bash
cd examples/kv-database
npm install
npx ts-node src/index.ts
npm test
```

### 2. queue-worker (Distributed Task Queue)

Demonstrates RangeCoordinator for work partitioning where each range acts as a task queue partition with ENQUEUE, DEQUEUE, and ACK operations.

```bash
cd examples/queue-worker
npm install
npx ts-node src/index.ts
npm test
```

### 3. api-server (HTTP-like API Cluster)

Demonstrates the Node class with Router, ConnectionManager, and message handlers for HTTP-like route handling across a cluster.

```bash
cd examples/api-server
npm install
npx ts-node src/index.ts
npm test
```

### 4. management-agent (Cluster Management Dashboard)

Demonstrates DiagnosticTool, MetricsTracker, and ChaosInjector for cluster monitoring, health dashboards, and fault injection experiments.

```bash
cd examples/management-agent
npm install
npx ts-node src/index.ts
npm test
```

## Shared Utilities

The `shared/` directory contains helpers used across examples:

- **cluster-helper.ts** -- factory functions for creating in-memory example clusters
- **logger.ts** -- simple console logger with timestamps and labels

## Architecture Notes

- All examples use `in-memory` transport (single-process demos)
- All imports use `'distributed-core'` to prove the package boundary
- Each example is self-contained and runnable standalone
