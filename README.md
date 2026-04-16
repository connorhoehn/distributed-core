
# Distributed Core

![CI](https://github.com/connorhoehn/distributed-core/actions/workflows/ci.yml/badge.svg)

A research kernel for distributed systems -- modular primitives for clustering, gossip, persistence, and transport with zero business-logic assumptions.

## Quick Start

```typescript
import { Node } from 'distributed-core';
import { InMemoryAdapter } from 'distributed-core';

const node = new Node({
  id: 'node-1',
  region: 'us-east-1',
  zone: 'us-east-1a',
  network: { address: '127.0.0.1', port: 8001 },
  seedNodes: ['127.0.0.1:8000']
});
await node.start();
```

## Features

- **Gossip-based membership** -- nodes discover each other and propagate state via configurable gossip strategies
- **Pluggable transport** -- InMemory, TCP, UDP, WebSocket, and HTTP adapters; swap at configuration time
- **Encrypted transport** -- optional message-level encryption and authentication
- **Write-ahead log & checkpointing** -- durable persistence with WAL, auto-checkpointing, compaction, and recovery
- **Failure detection** -- phi-accrual style failure detector for marking nodes suspect/dead
- **Quorum** -- quorum primitives for distributed decisions
- **Resource management** -- registry, distribution, and subscription system for cluster resources
- **Circuit breaking & retry** -- transport-level resilience with circuit breakers and retry managers
- **Message batching** -- configurable batching for throughput-sensitive workloads
- **Chaos injection** -- built-in diagnostics and chaos tools for testing resilience
- **Metrics & observability** -- metrics tracking, export, and cluster introspection

## Architecture

The system is organized into four layers:

**Transport** -- Pluggable network adapters (`InMemory`, `TCP`, `UDP`, `WebSocket`, `HTTP`) with optional encryption, circuit breaking, retry, and batching.

**Persistence** -- Write-ahead log, state store, broadcast buffer, auto-checkpointing, compaction, and crash recovery. Memory and file-backed backends.

**Cluster** -- Gossip protocol, membership table, failure detection, quorum, topology management, delta-sync, reconciliation, and state aggregation. Coordinators: `Gossip`, `InMemory`, `Etcd`, `Zookeeper`.

**Resources** -- Resource registry, distribution engine, attachment, security, and subscription management for assigning work across the cluster.

## Examples

Examples live in `/examples/` and run with `ts-node`:

| Example | Description | Run |
|---|---|---|
| **basic-cluster** | 3-node cluster formation, gossip, messaging, graceful shutdown | `npm run example:basic` |
| **chat-room** | Chat room coordination across a cluster | `npm run example:chat:tcp` |
| **distributed-counter** | HTTP-based distributed counter (WIP) | `npm run example:counter:http` |

## Project Goals

- **Research kernel** -- primitives for cluster join, gossip, replication, quorum, persistence, and compaction
- **No business logic** -- zero assumptions about downstream use cases; the core is protocol, not product
- **Examples-driven** -- all real-world scenarios live in `/examples/` as playgrounds, not in core
- **Front door API** -- `Node`, `ClusterManager`, and factory entrypoints for easy bootstrapping

## Running Tests

```bash
npm test                    # unit tests
npm run test:integration    # integration tests
npm run build               # compile TypeScript
npm run lint                # lint
```

## Current State

**Working:**
- Gossip protocol and cluster membership (join, leave, failure detection)
- Transport layer with InMemory, TCP, UDP, and WebSocket adapters
- Write-ahead log, checkpointing, compaction, and recovery
- Resource registry and distribution
- Message batching, encryption, circuit breaking
- Metrics, introspection, chaos injection
- Basic cluster and chat room examples

**In progress:**
- Node factory refactor (simplifying cluster bootstrap)
- Distributed counter example
- Etcd and Zookeeper coordinator integrations (interfaces exist, runtime testing ongoing)
- CLI and agent entrypoints

## License

MIT
