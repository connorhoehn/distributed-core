# Cluster Coordination Implementation Plan

## Overview
This document outlines the implementation of a complete distributed membership system with gossip protocol, reincarnation handling, and consistent hashing for the distributed-core library.

## Core Components

### 1. Enhanced MembershipTable
- **Current State**: Basic structure exists
- **Enhancements Needed**:
  - Version/incarnation tracking for reincarnation detection
  - Status transitions (ALIVE → SUSPECT → DEAD)
  - Metadata storage for node roles/regions
  - Efficient lookups and updates

### 2. Message Protocol
- **JOIN Messages**: Node discovery and bootstrap
- **GOSSIP Messages**: Periodic membership updates
- **Version-based Updates**: Reincarnation handling
- **Membership Snapshots**: Full state synchronization

### 3. Consistent Hash Ring
- **Virtual Nodes**: N replicas per physical node (default: 100)
- **Dynamic Ring Updates**: Add/remove nodes based on membership
- **Key Routing**: Efficient key → node mapping
- **Zone Awareness**: Optional geographic distribution

### 4. Failure Detection
- **Heartbeat System**: Periodic liveness checks
- **Suspect Marking**: Gradual failure detection
- **Recovery Handling**: Reincarnation after restart

## Implementation Phases

### Phase 1: Core Membership & Versioning
1. Enhance `MembershipTable` with version tracking
2. Implement `NodeInfo` with incarnation numbers
3. Add version comparison logic for updates
4. Create basic JOIN/GOSSIP message handlers

### Phase 2: Gossip Protocol
1. Implement periodic gossip sender
2. Add target selection algorithms
3. Create membership diff calculation
4. Handle gossip message reception

### Phase 3: Consistent Hashing
1. Implement `ConsistentHashRing` class
2. Add virtual node management
3. Create key routing methods
4. Integrate with membership updates

### Phase 4: Failure Detection
1. Add heartbeat mechanism
2. Implement SUSPECT/DEAD transitions
3. Create recovery detection
4. Add timeout-based failure marking

## Integration Points

### With Existing Systems
- **ConnectionManager**: Use tags for node metadata
- **Session Management**: Route connections via consistent hashing
- **Messaging System**: Send cluster messages through Router
- **Transport Layer**: Abstract communication via adapters

### Event System
- Leverage existing EventEmitter patterns
- Emit cluster events: member-joined, member-left, topology-changed
- Enable reactive updates in application layer

## Data Structures

### NodeInfo
```typescript
interface NodeInfo {
  id: NodeId;
  status: 'ALIVE' | 'SUSPECT' | 'DEAD';
  version: number; // incarnation counter
  lastSeen: number;
  metadata: {
    role?: string;
    region?: string;
    zone?: string;
    [key: string]: any;
  };
}
```

### ClusterMessage
```typescript
interface ClusterMessage {
  type: 'JOIN' | 'GOSSIP';
  isResponse?: boolean;
  sender: NodeId;
  data: {
    nodeInfo?: NodeInfo;
    membershipDiff?: NodeInfo[];
    snapshot?: NodeInfo[];
  };
}
```

## Testing Strategy
- Unit tests for each component
- Integration tests for message flows
- Chaos testing for failure scenarios
- Performance tests for large clusters (1000+ nodes)

## Performance Considerations
- Configurable gossip intervals
- Batch membership updates
- Efficient hash ring operations
- Memory-efficient storage for large clusters

## Configuration
Extend `BootstrapConfig` with:
- Gossip settings (interval, fanout, retries)
- Failure detection timeouts
- Virtual node count
- Zone/region awareness

This implementation will provide a robust foundation for distributed applications requiring cluster coordination, load balancing, and fault tolerance.
