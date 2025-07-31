# ClusterManager Refactoring Plan

Your ClusterManager.ts file is large and implements many responsibilities. Splitting it into modular, testable units will improve maintainability and clarity.

Here's a plan for splitting ClusterManager.ts into logical modules, based on responsibilities:

---

## 🔹 1. Lifecycle Management

interface IClusterLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
  leave(timeout?: number): Promise<void>;
}

interface IClusterConsensus {
  hasQuorum(opts: QuorumOptions): boolean;
  detectPartition(): PartitionInfo | null;
}

**File:** `lifecycle/ClusterLifecycle.ts`

**Responsibilities:**
- `start()`
- `stop()`
- `leave()`
- `drainNode()`
- `rebalanceCluster()`
- `incrementVersion()`

These functions handle the lifecycle of the cluster and the node.

---

## 🔹 2. Join & Gossip Logic

**File:** `communication/ClusterJoinAndGossip.ts`

**Responsibilities:**
- `joinCluster()`
- `startGossipTimer()`
- `handleGossipMessage()`
- `handleJoinMessage()`
- `sendJoinResponse()`
- `runAntiEntropyCycle()`

Split the gossip and join logic into their own file. These functions handle inter-node communication.

---

## 🔹 3. Message Handling

**File:** `handlers/ClusterMessageHandler.ts`

**Responsibilities:**
- `handleMessage()`
- `hasSignature()`
- `verifyNodeMessage()`

Message validation, routing, and handling logic lives here.

---

## 🔹 4. Membership Utilities

**File:** `membership/ClusterMembershipUtils.ts`

**Responsibilities:**
- `getMembership()`
- `getMemberCount()`
- `getNodeInfo()`
- `getAliveMembers()`
- `markNodeSuspect()`
- `markNodeDead()`
- `pruneDeadNodes()`

This deals with viewing and modifying membership.

---

## 🔹 5. Hash Ring Access

**File:** `routing/ClusterRouting.ts`

**Responsibilities:**
- `getNodeForKey()`
- `getReplicaNodes()`
- `getNodesForKey()`
- `getLocalityAwareNodes()`

For consistent hashing, routing, and locality-aware strategies.

---

## 🔹 6. Metadata, Topology & Health

**File:** `introspection/ClusterIntrospection.ts`

**Responsibilities:**
- `getMetadata()`
- `getClusterMetadata()`
- `getClusterHealth()`
- `getTopology()`
- `calculateLoadBalance()`
- `canHandleFailures()`

For summarizing state of the cluster.

---

## 🔹 7. Quorum and Partition Handling

**File:** `consensus/ClusterConsensus.ts`

**Responsibilities:**
- `hasQuorum()`
- `detectPartition()`

Everything related to consensus and fault domains.

---

## 🔹 8. Key Management Interface

**File:** `security/ClusterKeyManagerFacade.ts`

**Responsibilities:**
- `getKeyManager()`
- `getPublicKey()`
- `pinNodeCertificate()`
- `unpinNodeCertificate()`
- `getPinnedCertificates()`

Expose KeyManager APIs from ClusterManager.

---

## 🔹 9. Utility Functions

**File:** `shared/ClusterUtils.ts` (or move to utils.ts)

**Functions:**
- `generateClusterId()`
- `addToRecentUpdates()`
- `getLocalNodeInfo()`

---

## 🔸 How to Wire it All Back

Keep ClusterManager.ts as the central class. Use composition or delegation:

```typescript
class ClusterManager extends EventEmitter {
  private lifecycleManager: ClusterLifecycle;
  private messageHandler: ClusterMessageHandler;
  private gossipHandler: ClusterJoinAndGossip;
  private membershipUtils: ClusterMembershipUtils;
  private routing: ClusterRouting;
  private introspection: ClusterIntrospection;
  private consensus: ClusterConsensus;
  private keyManagerFacade: ClusterKeyManagerFacade;

  constructor(
    localNodeId: string,
    transport: Transport,
    config: BootstrapConfig,
    virtualNodesPerNode: number = 100,
    nodeMetadata: any = {}
  ) {
    super();
    
    // Initialize core components first
    this.membership = new MembershipTable(localNodeId);
    this.gossipStrategy = new GossipStrategy(localNodeId, transport, config.gossipInterval, config.enableLogging);
    this.hashRing = new ConsistentHashRing(virtualNodesPerNode);
    this.keyManager = new KeyManager({ ...config.keyManager, enableLogging: config.enableLogging });
    this.failureDetector = new FailureDetector(/* ... */);
    
    // Initialize delegated managers
    this.lifecycleManager = new ClusterLifecycle(this);
    this.messageHandler = new ClusterMessageHandler(this);
    this.gossipHandler = new ClusterJoinAndGossip(this);
    this.membershipUtils = new ClusterMembershipUtils(this);
    this.routing = new ClusterRouting(this);
    this.introspection = new ClusterIntrospection(this);
    this.consensus = new ClusterConsensus(this);
    this.keyManagerFacade = new ClusterKeyManagerFacade(this);
  }

  // Delegate lifecycle methods
  async start(): Promise<void> {
    return this.lifecycleManager.start();
  }

  async stop(): Promise<void> {
    return this.lifecycleManager.stop();
  }

  async leave(timeout?: number): Promise<void> {
    return this.lifecycleManager.leave(timeout);
  }

  // Delegate membership methods
  getMembership(): Map<string, MembershipEntry> {
    return this.membershipUtils.getMembership();
  }

  getMemberCount(): number {
    return this.membershipUtils.getMemberCount();
  }

  // Delegate routing methods
  getNodeForKey(key: string): string | null {
    return this.routing.getNodeForKey(key);
  }

  // Delegate consensus methods
  hasQuorum(opts: QuorumOptions): boolean {
    return this.consensus.hasQuorum(opts);
  }

  detectPartition(): PartitionInfo | null {
    return this.consensus.detectPartition();
  }

  // ... other delegated methods
}
```

Each helper class receives a reference to ClusterManager or required dependencies.

---

## 📦 Folder Organization Suggestion

```
src/cluster/
├── ClusterManager.ts                 # Main orchestrator
├── core/
│   ├── lifecycle/
│   │   ├── ClusterLifecycle.ts
│   │   └── types.ts
│   ├── communication/
│   │   ├── ClusterJoinAndGossip.ts
│   │   └── types.ts
│   ├── handlers/
│   │   ├── ClusterMessageHandler.ts
│   │   └── types.ts
│   ├── membership/
│   │   ├── ClusterMembershipUtils.ts
│   │   └── types.ts
│   ├── routing/
│   │   ├── ClusterRouting.ts
│   │   ├── strategies/
│   │   └── types.ts
│   ├── introspection/
│   │   ├── ClusterIntrospection.ts
│   │   ├── metrics/
│   │   └── types.ts
│   ├── consensus/
│   │   ├── ClusterConsensus.ts
│   │   └── quorum/          # Your existing quorum strategies
│   ├── security/
│   │   ├── ClusterKeyManagerFacade.ts
│   │   └── types.ts
│   └── shared/
│       ├── ClusterUtils.ts
│       ├── events/
│       ├── config/
│       └── types.ts
├── quorum/                           # Existing quorum strategies
│   ├── README.md
│   ├── index.ts
│   └── ...

test/unit/cluster/
├── ClusterManager.unit.test.ts       # Existing main tests
├── core/
│   ├── lifecycle/
│   │   └── ClusterLifecycle.unit.test.ts
│   ├── communication/
│   │   └── ClusterJoinAndGossip.unit.test.ts
│   ├── handlers/
│   │   └── ClusterMessageHandler.unit.test.ts
│   ├── membership/
│   │   └── ClusterMembershipUtils.unit.test.ts
│   ├── routing/
│   │   └── ClusterRouting.unit.test.ts
│   ├── introspection/
│   │   └── ClusterIntrospection.unit.test.ts
│   ├── consensus/
│   │   └── ClusterConsensus.unit.test.ts
│   ├── security/
│   │   └── ClusterKeyManagerFacade.unit.test.ts
│   └── shared/
│       └── ClusterUtils.unit.test.ts
├── quorum/                           # Existing quorum tests
│   └── advanced-quorum-strategies.unit.test.ts

test/integration/cluster/
├── cluster-modules.integration.test.ts
├── lifecycle-integration.test.ts
├── communication-integration.test.ts
└── consensus-integration.test.ts
```

---

## 🚀 Migration Strategy

### **Phase 1: Extract Pure Functions** (Low Risk)
Start with stateless utilities:
1. `shared/ClusterUtils.ts` 
2. `routing/ClusterRouting.ts`
3. `introspection/ClusterIntrospection.ts`

### **Phase 2: Extract Handlers** (Medium Risk)
Move message and event handling:
1. `handlers/ClusterMessageHandler.ts`
2. `consensus/ClusterConsensus.ts`

### **Phase 3: Extract State Managers** (High Risk)
Move stateful components:
1. `lifecycle/ClusterLifecycle.ts`
2. `membership/ClusterMembershipUtils.ts`
3. `communication/ClusterJoinAndGossip.ts`

### **Phase 4: Final Integration** (Validation)
Wire everything together with proper dependency injection.

---

## 🔧 Interface-Driven Design

### **Core Interfaces**

```typescript
// shared/types.ts
interface IClusterLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
  leave(timeout?: number): Promise<void>;
  drainNode(nodeId: string, timeout?: number): Promise<boolean>;
  rebalanceCluster(): void;
  incrementVersion(): void;
}

interface IClusterConsensus {
  hasQuorum(opts: QuorumOptions): boolean;
  detectPartition(): PartitionInfo | null;
  runAntiEntropyCycle(): void;
}

interface IClusterMembership {
  getMembership(): Map<string, MembershipEntry>;
  getMemberCount(): number;
  getNodeInfo(): NodeInfo;
  getAliveMembers(): MembershipEntry[];
  markNodeSuspect(nodeId: string): boolean;
  markNodeDead(nodeId: string): boolean;
  pruneDeadNodes(maxAge?: number): number;
}

interface IClusterRouting {
  getNodeForKey(key: string): string | null;
  getReplicaNodes(key: string, replicaCount?: number): string[];
  getNodesForKey(key: string, options?: any): string[];
}

interface IClusterIntrospection {
  getMetadata(): ClusterMetadata;
  getClusterHealth(): ClusterHealth;
  getTopology(): ClusterTopology;
  canHandleFailures(nodeCount: number): boolean;
}
```

### **Dependency Injection**

```typescript
interface ClusterManagerDependencies {
  membership: MembershipTable;
  gossipStrategy: GossipStrategy;
  hashRing: ConsistentHashRing;
  failureDetector: FailureDetector;
  keyManager: KeyManager;
  transport: Transport;
  config: BootstrapConfig;
}

interface ClusterModuleConfig {
  lifecycle: LifecycleConfig;
  gossip: GossipConfig;
  consensus: ConsensusConfig;
  routing: RoutingConfig;
  introspection: IntrospectionConfig;
}
```

---

## 🧪 Testing Strategy

### **Unit Testing**
Each module gets its own comprehensive test suite in the `test/unit/cluster/core/` directory:

```typescript
// test/unit/cluster/core/lifecycle/ClusterLifecycle.unit.test.ts
describe('ClusterLifecycle', () => {
  let lifecycle: ClusterLifecycle;
  let mockClusterManager: jest.Mocked<ClusterManager>;

  beforeEach(() => {
    mockClusterManager = createMockClusterManager();
    lifecycle = new ClusterLifecycle(mockClusterManager);
  });

  describe('start()', () => {
    it('should initialize cluster components', async () => {
      await lifecycle.start();
      expect(mockClusterManager.membership.addLocalNode).toHaveBeenCalled();
      expect(mockClusterManager.transport.start).toHaveBeenCalled();
    });
  });
});
```

### **Integration Testing**
Test module interactions in the `test/integration/cluster/` directory:

```typescript
// test/integration/cluster/cluster-modules.integration.test.ts
describe('Cluster Module Integration', () => {
  it('should coordinate lifecycle and membership correctly', async () => {
    const clusterManager = new ClusterManager(/* ... */);
    await clusterManager.start();
    
    expect(clusterManager.getMemberCount()).toBe(1);
    expect(clusterManager.hasQuorum({ minNodeCount: 1 })).toBe(true);
  });
});
```

---

## 🎯 Benefits You'll Gain

### **Immediate Benefits**
- **Testability**: Each module can be unit tested in isolation
- **Maintainability**: Easier to locate and modify specific functionality
- **Code Clarity**: Each module's purpose is immediately clear
- **Reduced Complexity**: Smaller, focused classes are easier to understand

### **Long-term Benefits**
- **Scalability**: New features can be added without touching core logic
- **Team Development**: Multiple developers can work on different modules
- **Performance**: Easier to optimize specific components
- **Documentation**: Each module can have focused documentation

### **Architecture Benefits**
- **Single Responsibility**: Each class has one clear purpose
- **Open/Closed Principle**: Easy to extend without modifying existing code
- **Dependency Inversion**: Modules depend on abstractions, not concretions
- **Interface Segregation**: Clean, focused interfaces

---

## 🛠️ Implementation Checklist

### **Pre-Refactoring**
- [ ] Create comprehensive test coverage for existing ClusterManager
- [ ] Document current behavior and edge cases
- [ ] Identify all dependencies and side effects
- [ ] Create interface definitions

### **Phase 1: Pure Functions**
- [ ] Extract `ClusterUtils.ts`
- [ ] Extract `ClusterRouting.ts`
- [ ] Extract `ClusterIntrospection.ts`
- [ ] Create unit tests for each module
- [ ] Verify ClusterManager still works with delegation

### **Phase 2: Handlers**
- [ ] Extract `ClusterMessageHandler.ts`
- [ ] Extract `ClusterConsensus.ts`
- [ ] Update event handling
- [ ] Test message flow

### **Phase 3: State Managers**
- [ ] Extract `ClusterLifecycle.ts`
- [ ] Extract `ClusterMembershipUtils.ts`
- [ ] Extract `ClusterJoinAndGossip.ts`
- [ ] Test state transitions

### **Phase 4: Integration**
- [ ] Create proper dependency injection
- [ ] Add comprehensive integration tests
- [ ] Performance testing
- [ ] Documentation updates

---

## 📝 Next Steps

1. **Start Small**: Begin with `ClusterUtils.ts` extraction
2. **Test Everything**: Maintain test coverage throughout
3. **Gradual Migration**: Keep ClusterManager functional during refactoring
4. **Interface First**: Define clean contracts between modules
5. **Document Changes**: Update architecture documentation

This refactoring will transform your monolithic ClusterManager into a **beautifully orchestrated distributed system architecture**! 🎯

---

**Status**: 🔵 Planning Phase Complete  
**Ready for**: Implementation Phase 1 - Pure Function Extraction
