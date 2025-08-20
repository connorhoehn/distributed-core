
# Distributed Core Sandbox

![CI](https://github.com/connorhoehn/distributed-core/actions/workflows/ci.yml/badge.svg)

## Overview
Distributed Core is a research kernel for distributed systems, providing modular primitives and subsystems for building clusters, agents, and distributed applications. It is not a business-logic framework; all real-world scenarios are implemented as examples outside the core.

### Features
- **Cluster Management**: Node membership, join/leave, topology, and resource registry.
- **Messaging & Transport**: Reliable message delivery, batching, encryption, circuit breaking, and retry logic.
- **Persistence**: Write-ahead log, state store, checkpointing, compaction, and memory backends.
- **Pluggable Coordinators**: Gossip, Etcd, Zookeeper, InMemory for cluster coordination and consensus.
- **Observability**: Metrics, logging, diagnostics, and chaos injection for testing resilience.
- **Front Door APIs**: Node, Cluster, Agent, and CLI entrypoints for bootstrapping and management.
- **Examples-Driven**: All downstream use cases (API server, queue, database, management agent) live in `/examples/`.

### Subsystems
- **Cluster**: Membership, topology, aggregation, lifecycle, reconciliation, seeding, and quorum.
- **Applications**: Registry, chat, and custom modules.
- **Messaging**: Router, handlers, cluster messaging, and transport adapters.
- **Persistence**: WAL, state store, broadcast buffer, checkpointing, compaction, and memory backends.
- **Identity**: Key management, node metadata, and authentication.
- **Monitoring**: Failure detection, metrics, and observability tools.
- **Diagnostics**: Chaos injection and diagnostic utilities.

## Project Goals
- **Research Kernel for Distributed Systems**: Modular primitives for cluster join, gossip, replication, quorum, persistence, compaction, and more.
- **No Business Logic**: Zero assumptions about downstream use cases (chat, queue, database, etc.).
- **Examples-Driven**: All real-world scenarios live in `/examples/` as playgrounds, not in core.
- **Front Door API**: Export Node, Cluster, Agent, and CLI entrypoints for easy bootstrapping and management.
- **Observability & Modularity**: Metrics, logs, and test coverage for every primitive.

## Current State
- Core modules for cluster management, resource registry, messaging, transport, and persistence.
- Pluggable coordinators (Gossip, Etcd, Zookeeper, InMemory).
- CLI and agent scaffolding in progress.
- Examples for API server, queue worker, database, and management agent planned.
- Integration tests for primitives; downstream tests coming via `/examples/`.

## How to Run Tests
```bash
npm test
npm run test:integration
```