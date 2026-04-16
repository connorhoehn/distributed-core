
# Distributed Core

![CI](https://github.com/connorhoehn/distributed-core/actions/workflows/ci.yml/badge.svg)

A research kernel for distributed systems -- modular primitives for clustering, gossip, persistence, and transport with zero business-logic assumptions.

## Quick Start

```typescript
import { DistributedNodeFactory } from 'distributed-core';

const components = await DistributedNodeFactory.builder()
  .id('node-1')
  .network('127.0.0.1', 8001)
  .transport('websocket')
  .seedNodes(['127.0.0.1:8000'])
  .enableResources()
  .build();

const { node } = components;
// node is now running, gossiping, and accepting connections
```

Or start a node from the command line:

```bash
npx ts-node src/cli/index.ts start --id node-1 --port 4000 --seed 127.0.0.1:4001
```

## Features

- **Gossip-based membership** -- nodes discover each other and propagate state via configurable gossip strategies
- **Pluggable transport** -- InMemory, TCP, UDP, WebSocket, and HTTP adapters; swap at configuration time
- **Encrypted transport** -- `EncryptedTransport` wrapper for message-level encryption and authentication
- **Write-ahead log & checkpointing** -- durable persistence with WAL, auto-checkpointing, and crash recovery
- **4 compaction strategies** -- time-based, size-tiered, leveled, and vacuum-based; selectable via `CompactionStrategyFactory`
- **Failure detection** -- phi-accrual style failure detector for marking nodes suspect/dead
- **Quorum** -- multiple strategies (consensus, adaptive, role-based, multi-level, zone-aware)
- **Resource management** -- registry, distribution engine, attachment, security, and subscription system
- **Delivery confirmation** -- ACK/NACK tracking via `DeliveryTracker` for resource operations
- **Resource subscriptions** -- filtered subscriptions for resource state changes across the cluster
- **Structured logging** -- `Logger` class with level control and component context, replacing raw `console.log`
- **Health check server** -- lightweight HTTP server exposing `/health`, `/status`, and `/metrics` endpoints
- **CLI entrypoint** -- start, health-check, and status commands with YAML config support
- **Node lifecycle framework** -- phased startup (init, network, membership, state-sync, client, ready) via `NodeLifecycle`
- **Factory & builder pattern** -- `DistributedNodeFactory` and `TransportFactory` for wiring nodes without manual plumbing
- **Circuit breaking & retry** -- transport-level resilience with circuit breakers and retry managers
- **Message batching** -- configurable batching for throughput-sensitive workloads
- **Chaos injection** -- built-in diagnostics and chaos tools for testing resilience
- **Metrics & observability** -- metrics tracking, export, and cluster introspection

## Architecture

The system is organized into five layers, each depending only on the layer below it:

```
Transport (InMemory, TCP, WebSocket, UDP, HTTP)
    |
Persistence (WAL, Checkpoint, Compaction, Recovery)
    |
Cluster (Gossip, Membership, Failure Detection, Quorum)
    |
Resources (Registry, Distribution, Subscriptions, Security)
    |
Services & Factories (Lifecycle, Wiring, Composition)
```

**Transport** -- Pluggable network adapters (`InMemory`, `TCP`, `UDP`, `WebSocket`, `HTTP`) with optional encryption, circuit breaking, retry, and batching. `EncryptedTransport` wraps any adapter to add message-level crypto.

**Persistence** -- Write-ahead log, state store, broadcast buffer, auto-checkpointing, and crash recovery. Four compaction strategies (time-based, size-tiered, leveled, vacuum) run on a configurable schedule. Memory and file-backed backends.

**Cluster** -- Gossip protocol, membership table, failure detection, quorum (with consensus, adaptive, role-based, multi-level, and zone-aware strategies), topology management, delta-sync, reconciliation, and state aggregation. Coordinators: `Gossip`, `InMemory`, `Etcd`, `Zookeeper`.

**Resources** -- Resource registry, distribution engine, delivery confirmation (ACK/NACK), attachment, security, quota management, and subscription system for assigning and tracking work across the cluster.

**Services & Factories** -- `NodeLifecycle` orchestrates phased startup. `DistributedNodeFactory` and `TransportFactory` wire everything together. `ResourceWiring` connects resources to the cluster. The CLI provides an operator-facing entrypoint.

## CLI Usage

The CLI lives at `src/cli/index.ts` and supports starting nodes, probing health, and querying status.

```bash
# Start a standalone node
npx ts-node src/cli/index.ts start --id node-1 --port 4000

# Start a node that joins an existing cluster
npx ts-node src/cli/index.ts start --id node-2 --port 4001 --seed 127.0.0.1:4000

# Start from a YAML config file
npx ts-node src/cli/index.ts start --config node.yaml

# Check if a node is reachable
npx ts-node src/cli/index.ts health --port 4000

# Query node status
npx ts-node src/cli/index.ts status --port 4000
```

Example YAML config (`node.yaml`):

```yaml
id: node-1
address: 127.0.0.1
port: 4000
transport: websocket
seeds:
  - 127.0.0.1:4001
  - 127.0.0.1:4002
enableLogging: true
```

## Examples

Examples live in `/examples/` and run with `ts-node`:

| Example | Description | Run |
|---|---|---|
| **basic-cluster** | 3-node cluster formation, gossip, messaging, graceful shutdown | `npm run example:basic` |
| **chat-room** | Chat room coordination across a cluster | `npm run example:chat` |
| **distributed-counter** | HTTP-based distributed counter | `npm run example:counter` |

## Project Goals

- **Research kernel** -- primitives for cluster join, gossip, replication, quorum, persistence, and compaction
- **No business logic** -- zero assumptions about downstream use cases; the core is protocol, not product
- **Examples-driven** -- all real-world scenarios live in `/examples/` as playgrounds, not in core
- **Front door API** -- `Node`, `DistributedNodeFactory`, and CLI entrypoints for easy bootstrapping

## Running Tests

```bash
npm test                    # unit tests
npm run test:integration    # integration tests
npm run build               # compile TypeScript
npm run lint                # lint
```

## Current State

**Production-ready primitives:**
- Gossip protocol and cluster membership (join, leave, failure detection)
- Transport layer with InMemory, TCP, UDP, WebSocket, and HTTP adapters
- Write-ahead log, checkpointing, all 4 compaction strategies, and recovery
- Resource registry, distribution, delivery tracking, and subscriptions
- Structured logging, health check server, and metrics export
- Message batching, encrypted transport, circuit breaking
- CLI for starting and probing nodes
- Node lifecycle with phased startup and graceful shutdown
- Factory/builder wiring (`DistributedNodeFactory`, `TransportFactory`)

**Experimental / in progress:**
- Etcd and Zookeeper coordinator integrations (interfaces exist, runtime testing ongoing)
- Distributed counter example (basic implementation, needs hardening)
- Cross-cluster federation (subscription primitives exist, no multi-cluster test harness yet)
- `HealthServer` HTTP endpoints (wired in, but not yet exercised end-to-end in CI)

## License

MIT
