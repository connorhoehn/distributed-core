# Contributing to distributed-core

## Getting Started

```bash
git clone https://github.com/connorhoehn/distributed-core.git
cd distributed-core
npm install
npm test
```

## Development

| Command | Purpose |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run lint` | Run ESLint across `src/` |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm test` | Run unit tests (Jest) |
| `npm run test:integration` | Run integration tests |
| `npm run test:watch` | Run tests in watch mode |

## Architecture

The codebase is organized in layers, each depending only on the layer below it:

```
services / factories   -- Node, ClusterManager, DistributedNodeFactory
        |
    resources          -- registry, distribution, subscriptions
        |
     cluster           -- gossip, membership, failure detection, quorum
        |
   persistence         -- WAL, checkpointing, compaction, recovery
        |
    transport          -- InMemory, TCP, UDP, WebSocket, HTTP adapters
```

Transport and persistence are infrastructure -- they know nothing about cluster logic.
Cluster depends on transport/persistence through interfaces, not concrete classes.
Resources sit above cluster and manage work distribution.
Factories and services wire everything together at the top.

## Testing

- **Unit tests** -- `test/unit/` -- fast, no network, no disk
- **Integration tests** -- `test/integration/` -- multi-node scenarios with real transports
- **Architecture fitness tests** -- `test/unit/architecture/` -- enforce layer boundaries at CI time

Run all unit tests with `npm test`. Run integration tests with `npm run test:integration`.

## Code Style

- ESLint is configured with `@typescript-eslint` (see `.eslintrc.js`)
- Use strict TypeScript -- prefer explicit types over inference for public APIs
- Avoid `as any` casts; use proper type narrowing or generics instead
- Use the project's `Logger` class instead of `console.log`
- Prefix unused variables with `_` (e.g., `_unusedParam`)
- Run `npm run lint` before committing

## Pull Requests

1. Branch from `main`
2. Keep commits focused -- one logical change per PR
3. Include tests for new behavior (unit at minimum, integration if multi-node)
4. Run `npm run lint` and `npm test` before pushing
5. Describe what changed and why in the PR description

## Architecture Rules

These rules are enforced by fitness tests in `test/unit/architecture/`:

- **Transport does not import cluster** -- transport is a low-level primitive with no knowledge of cluster concepts
- **Persistence does not import cluster** -- persistence handles storage, not coordination
- **Cluster uses interfaces for resources** -- cluster code depends on resource interfaces, never concrete resource classes

Violating these boundaries will fail CI. If you need cross-layer communication, define an interface in the lower layer and implement it in the higher one.
