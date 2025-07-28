# Distributed Core

This repository contains the foundational components for a distributed system runtime. It is designed to support decentralized service coordination and monitoring through a pluggable architecture that can power systems like real-time media clusters, event streaming, and telemetry backplanes.

This project is **not tied to any specific application domain like WebRTC or MediaSoup**, but instead focuses on core features such as gossip-based membership, failure detection, persistent state, diagnostics, and distributed transport coordination.

---

## 🧱 Core Features

- **Cluster Formation & Gossip**  
  Bootstrap nodes, exchange metadata, maintain health via gossip.

- **Failure Detection**  
  Detect and propagate node failures using heartbeat and timeout strategies.

- **Distributed State Persistence**  
  Write-ahead logging and optional state stores for local durability.

- **Metrics & Diagnostics**  
  Chaos injection, health probes, and metrics exporting via tracker modules.

- **Modular Transport Layer**  
  Abstract message delivery with support for encryption, backoff, and caching.

---

## 📁 Project Structure
```
distributed-core/
├── src/
│   ├── cluster/              # Membership table, gossip, failure detection
│   ├── common/               # Shared node structures and utility functions
│   ├── diagnostics/          # Chaos injection and diagnostics tooling
│   ├── identity/             # Key and node metadata management
│   ├── metrics/              # Metrics exporters and tracking logic
│   ├── persistence/          # WAL, state storage, buffers
│   ├── transport/            # Gossip message layer, encryption, backoff
│   ├── types.ts              # Shared TypeScript types
│   └── index.ts              # Entry point for starting a test cluster
├── test/                     # Integration and behavior tests
│   ├── harness/              # Test cluster creation and management
│   │   └── createTestCluster.ts
│   ├── fixtures/             # Test data and sample objects
│   │   ├── nodes.ts          # Sample node configurations
│   │   └── messages.ts       # Sample message payloads
│   ├── helpers/              # Test utilities and mocks
│   │   ├── mockTransport.ts  # Mock transport layer
│   │   └── spyLogger.ts      # Test logging utility
│   ├── cluster.test.ts
│   ├── gossip-flow.test.ts
│   ├── metrics-collection.test.ts
│   └── …
├── package.json
├── jest.config.js
├── tsconfig.json
└── README.md
```
---

## ✅ Tests

- All core modules have colocated unit tests under `src/**/__tests__`
- System-level tests live in `test/`
- Run tests with:

```bash
npm install
npm test

--- 
🚀 Next Steps
	1.	Add Mocks & Fixtures
	•	Create /test/fixtures and /test/helpers to simulate node states and cluster behavior.
	2.	Implement Node CLI Tool
	•	Provide scripts/dev-node.ts to launch nodes with different configurations for testing.
	3.	Add Metrics Exporter Interface
	•	Wire MetricsTracker to export Prometheus or JSON snapshots.
	4.	Introduce Cluster Harness
	•	Provide a harness that can spin up multiple nodes and simulate communication.
	5.	Add ESLint/Prettier
	•	Enforce consistent formatting and avoid bugs.
	6.	Add GitHub Actions CI
	•	Create .github/workflows/test.yml for PR validation and coverage reporting.
	7.	Publish Documentation
	•	Use typedoc or custom Markdown in /docs to explain lifecycle, message flow, and usage.