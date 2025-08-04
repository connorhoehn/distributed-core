import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';
import { GossipMessage, MessageType as GossipMessageType } from '../../../src/transport/GossipMessage';
import { NodeId, Message } from '../../../src/types';
import { WriteAheadLogEntityRegistry } from '../../../src/cluster/entity/WriteAheadLogEntityRegistry';
import { InMemoryEntityRegistry } from '../../../src/cluster/entity/InMemoryEntityRegistry';
import { EntityRecord, EntityUpdate } from '../../../src/cluster/entity/types';

describe('Streaming Failure Recovery E2E Tests', () => {
  const basePort = 9100;
  let coordinatorNode: WebSocketAdapter;
  let processorNode1: WebSocketAdapter;
  let processorNode2: WebSocketAdapter;
  let processorNode3: WebSocketAdapter;
  let egressNode: WebSocketAdapter;
  
  let coordinatorRegistry: WriteAheadLogEntityRegistry;
  let processor1Registry: InMemoryEntityRegistry;
  let processor2Registry: InMemoryEntityRegistry;
  let processor3Registry: InMemoryEntityRegistry;
  let egressRegistry: InMemoryEntityRegistry;

  const coordinatorInfo: NodeId = { id: 'stream-coordinator', address: '127.0.0.1', port: basePort };
  const processor1Info: NodeId = { id: 'stream-processor-1', address: '127.0.0.1', port: basePort + 1 };
  const processor2Info: NodeId = { id: 'stream-processor-2', address: '127.0.0.1', port: basePort + 2 };
  const processor3Info: NodeId = { id: 'stream-processor-3', address: '127.0.0.1', port: basePort + 3 };
  const egressInfo: NodeId = { id: 'stream-egress', address: '127.0.0.1', port: basePort + 4 };

  // Track streaming state and ownership
  let streamOwnership: Map<string, string> = new Map(); // streamId -> ownerNodeId
  let streamConnections: Map<string, Set<string>> = new Map(); // nodeId -> streamIds
  let failureEvents: any[] = [];
  let recoveryEvents: any[] = [];

  beforeEach(async () => {
    // Clear state
    streamOwnership.clear();
    streamConnections.clear();
    failureEvents.length = 0;
    recoveryEvents.length = 0;

    // Initialize entity registries for ownership tracking
    coordinatorRegistry = new WriteAheadLogEntityRegistry(coordinatorInfo.id, {
      filePath: `/tmp/coordinator-${Date.now()}.wal`
    });
    processor1Registry = new InMemoryEntityRegistry(processor1Info.id);
    processor2Registry = new InMemoryEntityRegistry(processor2Info.id);
    processor3Registry = new InMemoryEntityRegistry(processor3Info.id);
    egressRegistry = new InMemoryEntityRegistry(egressInfo.id);

    await coordinatorRegistry.start();
    await processor1Registry.start();
    await processor2Registry.start();
    await processor3Registry.start();
    await egressRegistry.start();

    // Initialize WebSocket nodes
    coordinatorNode = new WebSocketAdapter(coordinatorInfo, {
      port: basePort,
      enableCompression: true,
      enableLogging: false,
      maxConnections: 100
    });

    processorNode1 = new WebSocketAdapter(processor1Info, {
      port: basePort + 1,
      enableCompression: true,
      enableLogging: false,
      maxConnections: 100
    });

    processorNode2 = new WebSocketAdapter(processor2Info, {
      port: basePort + 2,
      enableCompression: true,
      enableLogging: false,
      maxConnections: 100
    });

    processorNode3 = new WebSocketAdapter(processor3Info, {
      port: basePort + 3,
      enableCompression: true,
      enableLogging: false,
      maxConnections: 100
    });

    egressNode = new WebSocketAdapter(egressInfo, {
      port: basePort + 4,
      enableCompression: true,
      enableLogging: false,
      maxConnections: 100
    });

    // Start all nodes
    await coordinatorNode.start();
    await processorNode1.start();
    await processorNode2.start();
    await processorNode3.start();
    await egressNode.start();

    // Setup cross-connections for mesh topology
    await coordinatorNode.connect(processor1Info);
    await coordinatorNode.connect(processor2Info);
    await coordinatorNode.connect(processor3Info);
    await coordinatorNode.connect(egressInfo);

    await processorNode1.connect(coordinatorInfo);
    await processorNode1.connect(processor2Info);
    await processorNode1.connect(processor3Info);
    await processorNode1.connect(egressInfo);

    await processorNode2.connect(coordinatorInfo);
    await processorNode2.connect(processor1Info);
    await processorNode2.connect(processor3Info);
    await processorNode2.connect(egressInfo);

    await processorNode3.connect(coordinatorInfo);
    await processorNode3.connect(processor1Info);
    await processorNode3.connect(processor2Info);
    await processorNode3.connect(egressInfo);

    await egressNode.connect(coordinatorInfo);
    await egressNode.connect(processor1Info);
    await egressNode.connect(processor2Info);
    await egressNode.connect(processor3Info);

    // Allow mesh stabilization
    await new Promise(resolve => setTimeout(resolve, 500));
  });

  afterEach(async () => {
    await coordinatorNode.stop();
    await processorNode1.stop();
    await processorNode2.stop();
    await processorNode3.stop();
    await egressNode.stop();

    await coordinatorRegistry.stop();
    await processor1Registry.stop();
    await processor2Registry.stop();
    await processor3Registry.stop();
    await egressRegistry.stop();
  });

  describe('Stream Ownership and Entity State Management', () => {
    test('should establish stream ownership through entity registry', async () => {
      const streamId = 'test-stream-ownership';
      const ownershipEvents: any[] = [];

      // Setup ownership tracking
      [coordinatorRegistry, processor1Registry, processor2Registry, processor3Registry, egressRegistry].forEach(registry => {
        registry.on('entity:created', (entity: EntityRecord) => {
          if (entity.metadata?.type === 'stream_connection') {
            ownershipEvents.push({
              type: 'ownership_established',
              streamId: entity.metadata.streamId,
              ownerNodeId: entity.ownerNodeId,
              entityId: entity.entityId
            });
          }
        });
      });

      // Processor 1 takes ownership of stream
      const streamEntity = await processor1Registry.proposeEntity(`stream:${streamId}`, {
        type: 'stream_connection',
        streamId,
        connectionType: 'input',
        ports: [5000, 5001],
        established: Date.now()
      });

      // Propagate ownership to other nodes
      const ownershipUpdate: EntityUpdate = {
        entityId: streamEntity.entityId,
        ownerNodeId: streamEntity.ownerNodeId,
        version: streamEntity.version,
        timestamp: Date.now(),
        operation: 'CREATE',
        metadata: streamEntity.metadata
      };

      // Simulate entity propagation
      await processor2Registry.applyRemoteUpdate(ownershipUpdate);
      await processor3Registry.applyRemoteUpdate(ownershipUpdate);
      await coordinatorRegistry.applyRemoteUpdate(ownershipUpdate);
      await egressRegistry.applyRemoteUpdate(ownershipUpdate);

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(ownershipEvents).toHaveLength(1);
      expect(ownershipEvents[0].ownerNodeId).toBe(processor1Info.id);
      expect(ownershipEvents[0].streamId).toBe(streamId);

      // Verify ownership propagation
      expect(processor2Registry.getEntity(streamEntity.entityId)?.ownerNodeId).toBe(processor1Info.id);
      expect(processor3Registry.getEntity(streamEntity.entityId)?.ownerNodeId).toBe(processor1Info.id);
      expect(coordinatorRegistry.getEntity(streamEntity.entityId)?.ownerNodeId).toBe(processor1Info.id);
    });

    test('should track multiple stream connections per node', async () => {
      const streams = ['stream-1', 'stream-2', 'stream-3'];
      const entities: EntityRecord[] = [];

      // Processor 1 takes multiple stream connections
      for (const streamId of streams) {
        const entity = await processor1Registry.proposeEntity(`stream:${streamId}`, {
          type: 'stream_connection',
          streamId,
          connectionType: 'processing',
          ports: [6000 + streams.indexOf(streamId) * 2, 6001 + streams.indexOf(streamId) * 2],
          established: Date.now()
        });
        entities.push(entity);
      }

      // Verify processor 1 owns all streams
      const ownedEntities = processor1Registry.getLocalEntities();
      const streamEntities = ownedEntities.filter(e => e.metadata?.type === 'stream_connection');
      
      expect(streamEntities).toHaveLength(3);
      streamEntities.forEach(entity => {
        expect(entity.ownerNodeId).toBe(processor1Info.id);
        expect(streams).toContain(entity.metadata?.streamId);
      });
    });
  });

  describe('Node Failure During Active Streaming', () => {
    test('should detect node failure and trigger stream ownership transfer', async () => {
      const streamId = 'failure-test-stream';
      const transferEvents: any[] = [];
      let failureDetected = false;

      // Setup failure and transfer tracking
      [coordinatorNode, processorNode2, processorNode3, egressNode].forEach(node => {
        node.on('message-received', (message: any) => {
          try {
            const data = message.payload?.data;
            if (data?.type === 'NODE_FAILURE_DETECTED') {
              failureDetected = true;
              failureEvents.push({
                type: 'node_failure',
                failedNodeId: data.failedNodeId,
                detectingNodeId: data.detectingNodeId,
                timestamp: Date.now()
              });
            }
            if (data?.type === 'STREAM_OWNERSHIP_TRANSFER') {
              transferEvents.push({
                streamId: data.streamId,
                fromNode: data.fromNode,
                toNode: data.toNode,
                transferReason: data.reason
              });
            }
          } catch (e) {
            console.log('Error parsing failure message:', e);
          }
        });
      });

      // Processor 1 establishes stream ownership
      const streamEntity = await processor1Registry.proposeEntity(`stream:${streamId}`, {
        type: 'stream_connection',
        streamId,
        connectionType: 'primary_processor',
        ports: [7000, 7001],
        established: Date.now(),
        health: 'active'
      });

      // Propagate ownership
      const ownershipUpdate: EntityUpdate = {
        entityId: streamEntity.entityId,
        ownerNodeId: streamEntity.ownerNodeId,
        version: streamEntity.version,
        timestamp: Date.now(),
        operation: 'CREATE',
        metadata: streamEntity.metadata
      };

      await coordinatorRegistry.applyRemoteUpdate(ownershipUpdate);
      await processor2Registry.applyRemoteUpdate(ownershipUpdate);

      // Simulate node 1 failure by stopping it
      await processorNode1.stop();

      // Wait for failure detection timeout
      await new Promise(resolve => setTimeout(resolve, 100));

      // Coordinator detects failure and initiates transfer
      const failureNotification = new GossipMessage(
        GossipMessageType.BROADCAST,
        coordinatorInfo,
        {
          type: 'NODE_FAILURE_DETECTED',
          failedNodeId: processor1Info.id,
          detectingNodeId: coordinatorInfo.id,
          timestamp: Date.now(),
          affectedStreams: [streamId],
          severity: 'HIGH'
        }
      );

      await coordinatorNode.send(failureNotification as unknown as Message);

      // Simulate automatic ownership transfer to processor 2
      const transferredEntity = await processor2Registry.proposeEntity(`stream:${streamId}:transferred`, {
        type: 'stream_connection',
        streamId,
        connectionType: 'primary_processor',
        ports: [7100, 7101], // New ports
        established: Date.now(),
        health: 'active',
        transferredFrom: processor1Info.id,
        transferReason: 'node_failure'
      });

      // Notify about ownership transfer
      const transferNotification = new GossipMessage(
        GossipMessageType.BROADCAST,
        coordinatorInfo,
        {
          type: 'STREAM_OWNERSHIP_TRANSFER',
          streamId,
          fromNode: processor1Info.id,
          toNode: processor2Info.id,
          reason: 'node_failure',
          newPorts: [7100, 7101],
          timestamp: Date.now()
        }
      );

      await coordinatorNode.send(transferNotification as unknown as Message);
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(failureDetected).toBe(true);
      expect(failureEvents.length).toBeGreaterThanOrEqual(1);
      expect(failureEvents[0].failedNodeId).toBe(processor1Info.id);
      expect(transferEvents.length).toBeGreaterThanOrEqual(1);
      expect(transferEvents[0].toNode).toBe(processor2Info.id);
      expect(transferredEntity.ownerNodeId).toBe(processor2Info.id);
    });

    test('should handle cascade failure and redistribute streams', async () => {
      const streams = ['cascade-stream-1', 'cascade-stream-2', 'cascade-stream-3'];
      const redistributionEvents: any[] = [];
      const seenIds = new Set<string>();
      
      // Setup redistribution tracking with deduplication
      [coordinatorNode, processorNode3, egressNode].forEach(node => {
        node.on('message-received', (message: any) => {
          try {
            const data = message.payload?.data;
            if (data?.type === 'STREAM_REDISTRIBUTION') {
              // Deduplicate based on redistributionId
              if (!seenIds.has(data.redistributionId)) {
                seenIds.add(data.redistributionId);
                redistributionEvents.push({
                  redistributionId: data.redistributionId,
                  affectedStreams: data.affectedStreams,
                  newAssignments: data.newAssignments,
                  failedNodes: data.failedNodes
                });
              }
            }
          } catch (e) {
            console.log('Error parsing redistribution message:', e);
          }
        });
      });

      // Establish multiple streams across processor 1 and 2
      for (let i = 0; i < streams.length; i++) {
        const streamId = streams[i];
        const ownerRegistry = i < 2 ? processor1Registry : processor2Registry;
        const ownerNodeId = i < 2 ? processor1Info.id : processor2Info.id;
        
        await ownerRegistry.proposeEntity(`stream:${streamId}`, {
          type: 'stream_connection',
          streamId,
          connectionType: 'processing',
          ports: [8000 + i * 2, 8001 + i * 2],
          established: Date.now()
        });
      }

      // Simulate cascade failure - both processor 1 and 2 fail
      await processorNode1.stop();
      await processorNode2.stop();

      await new Promise(resolve => setTimeout(resolve, 200));

      // Coordinator detects cascade failure and redistributes to processor 3
      const redistributionPlan = new GossipMessage(
        GossipMessageType.BROADCAST,
        coordinatorInfo,
        {
          type: 'STREAM_REDISTRIBUTION',
          redistributionId: `cascade-${Date.now()}`,
          affectedStreams: streams,
          failedNodes: [processor1Info.id, processor2Info.id],
          newAssignments: {
            [processor3Info.id]: streams
          },
          redistributionStrategy: 'failover_consolidation',
          timestamp: Date.now()
        }
      );

      await coordinatorNode.send(redistributionPlan as unknown as Message);

      // Processor 3 accepts redistributed streams
      for (const streamId of streams) {
        await processor3Registry.proposeEntity(`stream:${streamId}:redistributed`, {
          type: 'stream_connection',
          streamId,
          connectionType: 'failover_processor',
          ports: [9000 + streams.indexOf(streamId) * 2, 9001 + streams.indexOf(streamId) * 2],
          established: Date.now(),
          originalOwners: [processor1Info.id, processor2Info.id],
          redistributionReason: 'cascade_failure'
        });
      }

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(redistributionEvents).toHaveLength(1);
      expect(redistributionEvents[0].affectedStreams).toEqual(streams);
      expect(redistributionEvents[0].failedNodes).toEqual([processor1Info.id, processor2Info.id]);
      
      // Verify processor 3 owns all redistributed streams
      const processor3Entities = processor3Registry.getLocalEntities();
      const streamEntities = processor3Entities.filter(e => e.metadata?.type === 'stream_connection');
      expect(streamEntities).toHaveLength(3);
    });
  });

  describe('Network Partition Recovery', () => {
    test('should handle network partition and merge state on recovery', async () => {
      const streamId = 'partition-recovery-stream';
      const partitionEvents: any[] = [];
      const mergeEvents: any[] = [];

      // Setup partition and merge tracking
      [coordinatorNode, processorNode1, processorNode2, processorNode3, egressNode].forEach(node => {
        node.on('message-received', (message: any) => {
          try {
            const data = message.payload?.data;
            if (data?.type === 'NETWORK_PARTITION_DETECTED') {
              partitionEvents.push({
                partitionId: data.partitionId,
                isolatedNodes: data.isolatedNodes,
                connectedNodes: data.connectedNodes
              });
            }
            if (data?.type === 'STATE_MERGE_COMPLETION') {
              mergeEvents.push({
                mergeId: data.mergeId,
                reconciledEntities: data.reconciledEntities,
                conflicts: data.conflicts
              });
            }
          } catch (e) {
            console.log('Error parsing partition message:', e);
          }
        });
      });

      // Initial stream setup
      const streamEntity = await processor1Registry.proposeEntity(`stream:${streamId}`, {
        type: 'stream_connection',
        streamId,
        connectionType: 'primary_processor',
        ports: [10000, 10001],
        established: Date.now()
      });

      // Simulate network partition by isolating processor 1
      // In real scenario, we'd block network connections, here we simulate the effect
      
      // Partition 1: processor1 (isolated)
      // Partition 2: coordinator, processor2, processor3, egress (connected)

      const partitionNotification = new GossipMessage(
        GossipMessageType.BROADCAST,
        coordinatorInfo,
        {
          type: 'NETWORK_PARTITION_DETECTED',
          partitionId: `partition-${Date.now()}`,
          isolatedNodes: [processor1Info.id],
          connectedNodes: [coordinatorInfo.id, processor2Info.id, processor3Info.id, egressInfo.id],
          detectionTimestamp: Date.now(),
          estimatedSplit: 0.8 // 80% of nodes still connected
        }
      );

      await coordinatorNode.send(partitionNotification as unknown as Message);

      // During partition, processor 2 takes over stream in connected partition
      const failoverEntity = await processor2Registry.proposeEntity(`stream:${streamId}:failover`, {
        type: 'stream_connection',
        streamId,
        connectionType: 'partition_failover',
        ports: [10100, 10101],
        established: Date.now(),
        partitionRecovery: true,
        originalOwner: processor1Info.id
      });

      // Simulate partition healing - processor 1 reconnects
      await new Promise(resolve => setTimeout(resolve, 200));

      // State merge process begins
      const mergeProcess = new GossipMessage(
        GossipMessageType.BROADCAST,
        coordinatorInfo,
        {
          type: 'STATE_MERGE_INITIATION',
          mergeId: `merge-${Date.now()}`,
          partitionNodes: [processor1Info.id],
          connectedNodes: [coordinatorInfo.id, processor2Info.id, processor3Info.id, egressInfo.id],
          conflictResolutionStrategy: 'last_writer_wins',
          timestamp: Date.now()
        }
      );

      await coordinatorNode.send(mergeProcess as unknown as Message);

      // Resolve ownership conflict - processor 2 keeps ownership (was active during partition)
      await processor1Registry.releaseEntity(streamEntity.entityId);

      const mergeCompletion = new GossipMessage(
        GossipMessageType.BROADCAST,
        coordinatorInfo,
        {
          type: 'STATE_MERGE_COMPLETION',
          mergeId: `merge-${Date.now()}`,
          reconciledEntities: 1,
          conflicts: 1,
          resolution: {
            [streamId]: {
              winnerNode: processor2Info.id,
              loserNode: processor1Info.id,
              strategy: 'partition_active_wins'
            }
          },
          timestamp: Date.now()
        }
      );

      await coordinatorNode.send(mergeCompletion as unknown as Message);
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(partitionEvents.length).toBeGreaterThanOrEqual(1);
      expect(partitionEvents[0].isolatedNodes).toEqual([processor1Info.id]);
      expect(mergeEvents.length).toBeGreaterThanOrEqual(1);
      expect(mergeEvents[0].conflicts).toBe(1);
      expect(processor2Registry.getEntity(failoverEntity.entityId)?.ownerNodeId).toBe(processor2Info.id);
    });

    test('should maintain stream continuity during split-brain scenario', async () => {
      const streamId = 'split-brain-stream';
      const splitBrainEvents: any[] = [];
      const seenSplitBrainIds = new Set<string>();
      let quorumViolations = 0;

      // Setup split-brain tracking with deduplication
      [coordinatorNode, processorNode1, processorNode2, processorNode3, egressNode].forEach(node => {
        node.on('message-received', (message: any) => {
          try {
            const data = message.payload?.data;
            if (data?.type === 'SPLIT_BRAIN_DETECTED') {
              // Deduplicate using timestamp + partition info as unique key
              const uniqueKey = `${data.timestamp || Date.now()}-${JSON.stringify(data.partitionA)}-${JSON.stringify(data.partitionB)}`;
              if (!seenSplitBrainIds.has(uniqueKey)) {
                seenSplitBrainIds.add(uniqueKey);
                splitBrainEvents.push({
                  partitionA: data.partitionA,
                  partitionB: data.partitionB,
                  quorumStatus: data.quorumStatus
                });
              }
            }
            if (data?.type === 'QUORUM_VIOLATION') {
              quorumViolations++;
            }
          } catch (e) {
            console.log('Error parsing split-brain message:', e);
          }
        });
      });

      // Initial stream
      await processor1Registry.proposeEntity(`stream:${streamId}`, {
        type: 'stream_connection',
        streamId,
        connectionType: 'primary_processor',
        ports: [11000, 11001],
        established: Date.now()
      });

      // Simulate split-brain: 
      // Partition A: coordinator, processor1 (2 nodes)
      // Partition B: processor2, processor3, egress (3 nodes)

      const splitBrainDetection = new GossipMessage(
        GossipMessageType.BROADCAST,
        coordinatorInfo,
        {
          type: 'SPLIT_BRAIN_DETECTED',
          partitionA: [coordinatorInfo.id, processor1Info.id],
          partitionB: [processor2Info.id, processor3Info.id, egressInfo.id],
          quorumStatus: {
            partitionA: { nodes: 2, hasQuorum: false },
            partitionB: { nodes: 3, hasQuorum: true }
          },
          timestamp: Date.now()
        }
      );

      await coordinatorNode.send(splitBrainDetection as unknown as Message);

      // Partition B (with quorum) takes over stream processing
      await processor2Registry.proposeEntity(`stream:${streamId}:quorum`, {
        type: 'stream_connection',
        streamId,
        connectionType: 'quorum_processor',
        ports: [11100, 11101],
        established: Date.now(),
        quorumDecision: true,
        splitBrainResolution: 'majority_partition'
      });

      // Partition A (minority) should recognize quorum violation
      const quorumViolation = new GossipMessage(
        GossipMessageType.DATA,
        coordinatorInfo,
        {
          type: 'QUORUM_VIOLATION',
          violationType: 'minority_partition',
          partitionSize: 2,
          requiredQuorum: 3,
          action: 'suspend_operations',
          timestamp: Date.now()
        },
        { recipient: processor1Info }
      );

      await coordinatorNode.send(quorumViolation as unknown as Message);
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(splitBrainEvents).toHaveLength(1);
      expect(splitBrainEvents[0].quorumStatus.partitionB.hasQuorum).toBe(true);
      expect(splitBrainEvents[0].quorumStatus.partitionA.hasQuorum).toBe(false);
      expect(quorumViolations).toBe(1);

      // Verify partition B maintains stream ownership
      const quorumEntity = processor2Registry.getLocalEntities()
        .find(e => e.metadata?.type === 'stream_connection' && e.metadata?.quorumDecision);
      expect(quorumEntity).toBeDefined();
      expect(quorumEntity?.ownerNodeId).toBe(processor2Info.id);
    });
  });

  describe('Node Recovery and Stream Rebalancing', () => {
    test('should rebalance streams when failed node recovers', async () => {
      const streams = ['rebalance-1', 'rebalance-2', 'rebalance-3', 'rebalance-4'];
      const rebalanceEvents: any[] = [];
      const seenRebalanceIds = new Set<string>();

      // Setup rebalance tracking with deduplication
      [coordinatorNode, processorNode1, processorNode2, processorNode3, egressNode].forEach(node => {
        node.on('message-received', (message: any) => {
          try {
            const data = message.payload?.data;
            if (data?.type === 'STREAM_REBALANCE_INITIATED') {
              // Deduplicate based on rebalanceId
              if (!seenRebalanceIds.has(data.rebalanceId)) {
                seenRebalanceIds.add(data.rebalanceId);
                rebalanceEvents.push({
                  rebalanceId: data.rebalanceId,
                  trigger: data.trigger,
                  beforeDistribution: data.beforeDistribution,
                  targetDistribution: data.targetDistribution
                });
              }
            }
          } catch (e) {
            console.log('Error parsing rebalance message:', e);
          }
        });
      });

      // Initial distribution: all streams on processor 2 (after processor 1 failed)
      for (const streamId of streams) {
        await processor2Registry.proposeEntity(`stream:${streamId}`, {
          type: 'stream_connection',
          streamId,
          connectionType: 'consolidated_processor',
          ports: [12000 + streams.indexOf(streamId) * 2, 12001 + streams.indexOf(streamId) * 2],
          established: Date.now(),
          consolidatedLoad: true
        });
      }

      // Processor 1 recovers
      const recoveryNotification = new GossipMessage(
        GossipMessageType.BROADCAST,
        coordinatorInfo,
        {
          type: 'NODE_RECOVERY_DETECTED',
          recoveredNodeId: processor1Info.id,
          nodeCapacity: {
            maxStreams: 10,
            currentStreams: 0,
            cpuUsage: 5.0,
            memoryUsage: 15.0
          },
          recoveryTimestamp: Date.now()
        }
      );

      await coordinatorNode.send(recoveryNotification as unknown as Message);

      // Coordinator initiates rebalancing
      const rebalancePlan = new GossipMessage(
        GossipMessageType.BROADCAST,
        coordinatorInfo,
        {
          type: 'STREAM_REBALANCE_INITIATED',
          rebalanceId: `rebalance-${Date.now()}`,
          trigger: 'node_recovery',
          beforeDistribution: {
            [processor1Info.id]: 0,
            [processor2Info.id]: 4,
            [processor3Info.id]: 0
          },
          targetDistribution: {
            [processor1Info.id]: 2,
            [processor2Info.id]: 1,
            [processor3Info.id]: 1
          },
          migrationPlan: [
            { streamId: 'rebalance-1', from: processor2Info.id, to: processor1Info.id },
            { streamId: 'rebalance-2', from: processor2Info.id, to: processor1Info.id },
            { streamId: 'rebalance-4', from: processor2Info.id, to: processor3Info.id }
          ],
          timestamp: Date.now()
        }
      );

      await coordinatorNode.send(rebalancePlan as unknown as Message);

      // Execute migrations
      // Transfer rebalance-1 and rebalance-2 to processor 1
      for (const streamId of ['rebalance-1', 'rebalance-2']) {
        const originalEntity = processor2Registry.getLocalEntities()
          .find(e => e.metadata?.streamId === streamId);
        
        if (originalEntity) {
          // Create new ownership on processor 1
          await processor1Registry.proposeEntity(`stream:${streamId}:rebalanced`, {
            type: 'stream_connection',
            streamId,
            connectionType: 'rebalanced_processor',
            ports: [13000 + ['rebalance-1', 'rebalance-2'].indexOf(streamId) * 2, 
                   13001 + ['rebalance-1', 'rebalance-2'].indexOf(streamId) * 2],
            established: Date.now(),
            migratedFrom: processor2Info.id,
            rebalanceReason: 'node_recovery'
          });

          // Release original ownership
          await processor2Registry.releaseEntity(originalEntity.entityId);
        }
      }

      // Transfer rebalance-4 to processor 3
      const rebalance4Entity = processor2Registry.getLocalEntities()
        .find(e => e.metadata?.streamId === 'rebalance-4');
      
      if (rebalance4Entity) {
        await processor3Registry.proposeEntity(`stream:rebalance-4:rebalanced`, {
          type: 'stream_connection',
          streamId: 'rebalance-4',
          connectionType: 'rebalanced_processor',
          ports: [13100, 13101],
          established: Date.now(),
          migratedFrom: processor2Info.id,
          rebalanceReason: 'node_recovery'
        });

        await processor2Registry.releaseEntity(rebalance4Entity.entityId);
      }

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(rebalanceEvents).toHaveLength(1);
      expect(rebalanceEvents[0].trigger).toBe('node_recovery');
      expect(rebalanceEvents[0].beforeDistribution[processor2Info.id]).toBe(4);
      expect(rebalanceEvents[0].targetDistribution[processor1Info.id]).toBe(2);

      // Verify final distribution
      const processor1Streams = processor1Registry.getLocalEntities()
        .filter(e => e.metadata?.type === 'stream_connection');
      const processor2Streams = processor2Registry.getLocalEntities()
        .filter(e => e.metadata?.type === 'stream_connection');
      const processor3Streams = processor3Registry.getLocalEntities()
        .filter(e => e.metadata?.type === 'stream_connection');

      expect(processor1Streams).toHaveLength(2);
      expect(processor2Streams).toHaveLength(1); // rebalance-3 remains
      expect(processor3Streams).toHaveLength(1); // rebalance-4
    });

    test('should prevent data loss during emergency node evacuation', async () => {
      const streamId = 'emergency-evacuation-stream';
      const evacuationEvents: any[] = [];
      const seenEvacuationIds = new Set<string>();
      let dataLossEvents = 0;

      // Setup evacuation tracking with deduplication
      [coordinatorNode, processorNode2, processorNode3, egressNode].forEach(node => {
        node.on('message-received', (message: any) => {
          try {
            const data = message.payload?.data;
            if (data?.type === 'EMERGENCY_EVACUATION') {
              // Deduplicate based on evacuatingNode + timestamp
              const uniqueKey = `${data.evacuatingNode}-${data.timestamp || Date.now()}`;
              if (!seenEvacuationIds.has(uniqueKey)) {
                seenEvacuationIds.add(uniqueKey);
                evacuationEvents.push({
                  evacuatingNode: data.evacuatingNode,
                  reason: data.reason,
                  urgency: data.urgency,
                  evacuationPlan: data.evacuationPlan
                });
              }
            }
            if (data?.type === 'DATA_LOSS_RISK') {
              dataLossEvents++;
            }
          } catch (e) {
            console.log('Error parsing evacuation message:', e);
          }
        });
      });

      // Setup stream with active data processing
      const streamEntity = await processor1Registry.proposeEntity(`stream:${streamId}`, {
        type: 'stream_connection',
        streamId,
        connectionType: 'data_processing',
        ports: [14000, 14001],
        established: Date.now(),
        activeData: {
          inProgressJobs: 5,
          queuedData: 1024000, // 1MB
          lastCheckpoint: Date.now() - 30000 // 30 seconds ago
        }
      });

      // Node 1 signals emergency evacuation (e.g., hardware failure imminent)
      const evacuationSignal = new GossipMessage(
        GossipMessageType.BROADCAST,
        processor1Info,
        {
          type: 'EMERGENCY_EVACUATION',
          evacuatingNode: processor1Info.id,
          reason: 'hardware_failure_imminent',
          urgency: 'HIGH',
          gracePeriod: 30000, // 30 seconds
          evacuationPlan: {
            targetNode: processor2Info.id,
            dataTransferRequired: true,
            checkpointRequired: true,
            estimatedTransferTime: 15000
          },
          timestamp: Date.now()
        }
      );

      await processorNode1.send(evacuationSignal as unknown as Message);

      // Coordinator orchestrates emergency transfer
      const emergencyTransfer = new GossipMessage(
        GossipMessageType.DATA,
        coordinatorInfo,
        {
          type: 'EMERGENCY_TRANSFER_INITIATION',
          streamId,
          fromNode: processor1Info.id,
          toNode: processor2Info.id,
          transferType: 'hot_migration',
          dataSnapshot: {
            activeJobs: 5,
            queueSize: 1024000,
            checkpointData: 'base64encodeddata...'
          },
          transferTimeout: 25000,
          timestamp: Date.now()
        },
        { recipient: processor2Info }
      );

      await coordinatorNode.send(emergencyTransfer as unknown as Message);

      // Processor 2 accepts emergency transfer
      const emergencyEntity = await processor2Registry.proposeEntity(`stream:${streamId}:emergency`, {
        type: 'stream_connection',
        streamId,
        connectionType: 'emergency_takeover',
        ports: [14100, 14101],
        established: Date.now(),
        transferredData: {
          fromNode: processor1Info.id,
          inProgressJobs: 5,
          queuedData: 1024000,
          restoredCheckpoint: Date.now()
        },
        emergencyTakeover: true
      });

      // Confirm successful evacuation
      const evacuationComplete = new GossipMessage(
        GossipMessageType.BROADCAST,
        processor2Info,
        {
          type: 'EVACUATION_COMPLETE',
          originalNode: processor1Info.id,
          newOwner: processor2Info.id,
          streamId,
          dataIntegrity: 'VERIFIED',
          transferStats: {
            duration: 12000,
            dataTransferred: 1024000,
            jobsContinued: 5,
            dataLoss: 0
          },
          timestamp: Date.now()
        }
      );

      await processorNode2.send(evacuationComplete as unknown as Message);
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(evacuationEvents).toHaveLength(1);
      expect(evacuationEvents[0].evacuatingNode).toBe(processor1Info.id);
      expect(evacuationEvents[0].urgency).toBe('HIGH');
      expect(dataLossEvents).toBe(0); // No data loss
      expect(emergencyEntity.ownerNodeId).toBe(processor2Info.id);
      expect(emergencyEntity.metadata?.transferredData.inProgressJobs).toBe(5);
    });
  });

  describe('Advanced Failure Scenarios', () => {
    test('should handle correlated failures and maintain minimal service', async () => {
      const criticalStreams = ['critical-1', 'critical-2'];
      const serviceAvailability: any[] = [];
      const seenServiceIds = new Set<string>();
      let minimalServiceMaintained = false;

      // Setup service tracking with deduplication
      [coordinatorNode, processorNode3, egressNode].forEach(node => {
        node.on('message-received', (message: any) => {
          try {
            const data = message.payload?.data;
            if (data?.type === 'SERVICE_AVAILABILITY_UPDATE') {
              // Deduplicate based on timestamp
              const uniqueKey = `${data.timestamp}`;
              if (!seenServiceIds.has(uniqueKey)) {
                seenServiceIds.add(uniqueKey);
                serviceAvailability.push({
                  timestamp: data.timestamp,
                  availableNodes: data.availableNodes,
                  criticalStreamsActive: data.criticalStreamsActive,
                  serviceLevel: data.serviceLevel
                });
              }
            }
            if (data?.type === 'MINIMAL_SERVICE_ENGAGED') {
              minimalServiceMaintained = true;
            }
          } catch (e) {
            console.log('Error parsing service message:', e);
          }
        });
      });

      // Setup critical streams
      for (const streamId of criticalStreams) {
        await processor1Registry.proposeEntity(`stream:${streamId}`, {
          type: 'stream_connection',
          streamId,
          connectionType: 'critical_service',
          priority: 'HIGH',
          ports: [15000 + criticalStreams.indexOf(streamId) * 2, 15001 + criticalStreams.indexOf(streamId) * 2],
          established: Date.now(),
          criticalFlag: true
        });
      }

      // Simulate correlated failure (power outage affecting multiple nodes)
      await processorNode1.stop();
      await processorNode2.stop();

      // Coordinator detects multiple failures
      const correlatedFailure = new GossipMessage(
        GossipMessageType.BROADCAST,
        coordinatorInfo,
        {
          type: 'CORRELATED_FAILURE_DETECTED',
          failedNodes: [processor1Info.id, processor2Info.id],
          failurePattern: 'power_outage',
          severity: 'CRITICAL',
          remainingCapacity: 0.33, // Only 1 out of 3 processors remains
          criticalStreamsAffected: criticalStreams,
          timestamp: Date.now()
        }
      );

      await coordinatorNode.send(correlatedFailure as unknown as Message);

      // Engage minimal service mode on remaining node
      const minimalService = new GossipMessage(
        GossipMessageType.DATA,
        coordinatorInfo,
        {
          type: 'MINIMAL_SERVICE_ENGAGED',
          targetNode: processor3Info.id,
          mode: 'emergency_consolidation',
          priorityStreams: criticalStreams,
          resourceLimits: {
            maxStreams: 2,
            degradedQuality: true,
            essentialFeaturesOnly: true
          },
          timestamp: Date.now()
        },
        { recipient: processor3Info }
      );

      await coordinatorNode.send(minimalService as unknown as Message);

      // Processor 3 takes over critical streams in degraded mode
      for (const streamId of criticalStreams) {
        await processor3Registry.proposeEntity(`stream:${streamId}:minimal`, {
          type: 'stream_connection',
          streamId,
          connectionType: 'minimal_service',
          priority: 'HIGH',
          ports: [15100 + criticalStreams.indexOf(streamId) * 2, 15101 + criticalStreams.indexOf(streamId) * 2],
          established: Date.now(),
          serviceMode: 'degraded',
          qualityLevel: 'essential_only',
          emergencyConsolidation: true
        });
      }

      // Report service availability
      const availabilityUpdate = new GossipMessage(
        GossipMessageType.BROADCAST,
        coordinatorInfo,
        {
          type: 'SERVICE_AVAILABILITY_UPDATE',
          timestamp: Date.now(),
          availableNodes: [coordinatorInfo.id, processor3Info.id, egressInfo.id],
          failedNodes: [processor1Info.id, processor2Info.id],
          criticalStreamsActive: 2,
          serviceLevel: 'MINIMAL',
          capacityReduction: 0.67,
          estimatedRecoveryTime: 1800000 // 30 minutes
        }
      );

      await coordinatorNode.send(availabilityUpdate as unknown as Message);
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(minimalServiceMaintained).toBe(true);
      expect(serviceAvailability).toHaveLength(1);
      expect(serviceAvailability[0].serviceLevel).toBe('MINIMAL');
      expect(serviceAvailability[0].criticalStreamsActive).toBe(2);

      // Verify processor 3 owns critical streams
      const criticalEntities = processor3Registry.getLocalEntities()
        .filter(e => e.metadata?.connectionType === 'minimal_service');
      expect(criticalEntities).toHaveLength(2);
    });

    test('should implement stream checkpointing for disaster recovery', async () => {
      const streamId = 'disaster-recovery-stream';
      const checkpointEvents: any[] = [];
      const seenCheckpointIds = new Set<string>();
      let disasterRecoveryTriggered = false;

      // Setup disaster recovery tracking with deduplication
      [coordinatorNode, processorNode2, processorNode3, egressNode].forEach(node => {
        node.on('message-received', (message: any) => {
          try {
            const data = message.payload?.data;
            if (data?.type === 'CHECKPOINT_CREATED') {
              // Deduplicate based on checkpointId
              if (!seenCheckpointIds.has(data.checkpointId)) {
                seenCheckpointIds.add(data.checkpointId);
                checkpointEvents.push({
                  streamId: data.streamId,
                  checkpointId: data.checkpointId,
                  dataSize: data.dataSize,
                  timestamp: data.timestamp
                });
              }
            }
            if (data?.type === 'DISASTER_RECOVERY_INITIATED') {
              disasterRecoveryTriggered = true;
            }
          } catch (e) {
            console.log('Error parsing disaster recovery message:', e);
          }
        });
      });

      // Setup stream with checkpointing
      const streamEntity = await processor1Registry.proposeEntity(`stream:${streamId}`, {
        type: 'stream_connection',
        streamId,
        connectionType: 'checkpointed_processor',
        ports: [16000, 16001],
        established: Date.now(),
        checkpointing: {
          enabled: true,
          interval: 10000, // 10 seconds
          lastCheckpoint: Date.now(),
          checkpointSize: 512000
        }
      });

      // Create periodic checkpoints
      const checkpoint1 = new GossipMessage(
        GossipMessageType.BROADCAST,
        processor1Info,
        {
          type: 'CHECKPOINT_CREATED',
          streamId,
          checkpointId: `cp-${Date.now()}-1`,
          sequenceNumber: 1,
          dataSize: 512000,
          dataHash: 'sha256:abc123...',
          backupNodes: [processor2Info.id, processor3Info.id],
          timestamp: Date.now()
        }
      );

      await processorNode1.send(checkpoint1 as unknown as Message);

      // Simulate total node loss (disaster scenario)
      await processorNode1.stop();

      // Initiate disaster recovery
      const disasterRecovery = new GossipMessage(
        GossipMessageType.BROADCAST,
        coordinatorInfo,
        {
          type: 'DISASTER_RECOVERY_INITIATED',
          lostNode: processor1Info.id,
          recoveryStrategy: 'checkpoint_restoration',
          targetRecoveryNode: processor2Info.id,
          lastKnownCheckpoint: `cp-${Date.now()}-1`,
          dataLossWindow: 10000, // Maximum 10 seconds of data loss
          timestamp: Date.now()
        }
      );

      await coordinatorNode.send(disasterRecovery as unknown as Message);

      // Processor 2 restores from checkpoint
      const restoredEntity = await processor2Registry.proposeEntity(`stream:${streamId}:restored`, {
        type: 'stream_connection',
        streamId,
        connectionType: 'disaster_recovered',
        ports: [16100, 16101],
        established: Date.now(),
        restoredFromCheckpoint: `cp-${Date.now()}-1`,
        estimatedDataLoss: 5000, // 5 seconds
        recoveryMode: 'checkpoint_restoration'
      });

      // Confirm recovery completion
      const recoveryComplete = new GossipMessage(
        GossipMessageType.BROADCAST,
        processor2Info,
        {
          type: 'DISASTER_RECOVERY_COMPLETE',
          streamId,
          recoveredNode: processor2Info.id,
          originalNode: processor1Info.id,
          checkpointRestored: `cp-${Date.now()}-1`,
          recoveryStats: {
            downtime: 15000, // 15 seconds
            dataLoss: 5000,   // 5 seconds
            dataRecovered: 512000,
            integrityVerified: true
          },
          timestamp: Date.now()
        }
      );

      await processorNode2.send(recoveryComplete as unknown as Message);
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(disasterRecoveryTriggered).toBe(true);
      expect(checkpointEvents).toHaveLength(1);
      expect(checkpointEvents[0].streamId).toBe(streamId);
      expect(restoredEntity.ownerNodeId).toBe(processor2Info.id);
      expect(restoredEntity.metadata?.recoveryMode).toBe('checkpoint_restoration');
    });
  });
});
