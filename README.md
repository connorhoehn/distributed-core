# Distributed Core Sandbox

![CI](https://github.com/connorhoehn/distributed-core/actions/workflows/ci.yml/badge.svg)

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

## GitHub Actions Workflow
Add this to `.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: npm test
      - run: npm run test:integration
```

## Badge Example
Add this to the top of your README:
```
![CI](https://github.com/<OWNER>/<REPO>/actions/workflows/ci.yml/badge.svg)
```
Replace `<OWNER>` and `<REPO>` with your GitHub username and repo name.