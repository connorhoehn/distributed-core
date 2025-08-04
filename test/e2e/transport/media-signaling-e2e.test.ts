import WebSocket from 'ws';
import { WebSocketAdapter } from '../../../src/transport/adapters/WebSocketAdapter';
import { GossipMessage, MessageType as GossipMessageType } from '../../../src/transport/GossipMessage';
import { NodeId, Message } from '../../../src/types';

describe('Media Signaling E2E Integration', () => {
  let ingressNode: WebSocketAdapter; // Media ingestion node
  let processorNode: WebSocketAdapter; // Media processing node
  let egressNode: WebSocketAdapter; // Media output node
  let coordinatorNode: WebSocketAdapter; // Signaling coordinator

  const basePort = 4000;
  const ingressInfo: NodeId = { id: 'media-ingress-1', address: '127.0.0.1', port: basePort };
  const processorInfo: NodeId = { id: 'media-processor-1', address: '127.0.0.1', port: basePort + 1 };
  const egressInfo: NodeId = { id: 'media-egress-1', address: '127.0.0.1', port: basePort + 2 };
  const coordinatorInfo: NodeId = { id: 'media-coordinator', address: '127.0.0.1', port: basePort + 3 };

  // Track signaling state
  let mediaStreams: Map<string, any> = new Map();
  let nodeStates: Map<string, any> = new Map();
  let activePorts: Map<string, number[]> = new Map();

  beforeEach(async () => {
    mediaStreams.clear();
    nodeStates.clear();
    activePorts.clear();

    // Initialize media processing nodes with different roles
    ingressNode = new WebSocketAdapter(ingressInfo, {
      port: basePort,
      enableCompression: true,
      enableLogging: false,
      maxConnections: 100
    });

    processorNode = new WebSocketAdapter(processorInfo, {
      port: basePort + 1,
      enableCompression: true,
      enableLogging: false,
      maxConnections: 100
    });

    egressNode = new WebSocketAdapter(egressInfo, {
      port: basePort + 2,
      enableCompression: true,
      enableLogging: false,
      maxConnections: 100
    });

    coordinatorNode = new WebSocketAdapter(coordinatorInfo, {
      port: basePort + 3,
      enableCompression: true,
      enableLogging: false,
      maxConnections: 200
    });

    // Start all nodes
    await Promise.all([
      ingressNode.start(),
      processorNode.start(),
      egressNode.start(),
      coordinatorNode.start()
    ]);

    // Establish mesh connections between nodes
    await Promise.all([
      ingressNode.connect(coordinatorInfo),
      processorNode.connect(coordinatorInfo),
      egressNode.connect(coordinatorInfo),
      ingressNode.connect(processorInfo),
      processorNode.connect(egressInfo)
    ]);

    // Give connections time to stabilize
    await new Promise(resolve => setTimeout(resolve, 200));
  });

  afterEach(async () => {
    await Promise.all([
      ingressNode?.stop(),
      processorNode?.stop(),
      egressNode?.stop(),
      coordinatorNode?.stop()
    ]);
  }, 10000);

  describe('Media Ingress Signaling', () => {
    test('should signal media stream start and allocate ingress ports', async () => {
      const receivedSignals: any[] = [];
      
      // Setup signal listeners on processing node using 'message-received' event
      processorNode.on('message-received', (message: any) => {
        try {
          // Access the data from the payload
          const data = message.payload?.data;
          
          if (data && data.type === 'MEDIA_STREAM_START') {
            receivedSignals.push(data);
          }
        } catch (e) {
          console.log('Error parsing message:', e);
        }
      });

      // Ingestion node signals start of media stream
      const streamId = `stream-${Date.now()}`;
      const mediaPort = 5000;
      const rtcpPort = 5001;
      
      const streamStartSignal = new GossipMessage(
        GossipMessageType.DATA,
        ingressInfo,
        {
          type: 'MEDIA_STREAM_START',
          streamId: streamId,
          mediaType: 'video',
          codec: 'h264',
          resolution: '1920x1080',
          bitrate: 2000000,
          mediaPort: mediaPort,
          rtcpPort: rtcpPort,
          timestamp: Date.now()
        },
        { recipient: processorInfo }
      );

      await ingressNode.send(streamStartSignal as unknown as Message);
      
      // Wait for signal processing
      await new Promise(resolve => setTimeout(resolve, 300));
      
      expect(receivedSignals).toHaveLength(1);
      expect(receivedSignals[0].streamId).toBe(streamId);
      expect(receivedSignals[0].mediaPort).toBe(mediaPort);
      expect(receivedSignals[0].rtcpPort).toBe(rtcpPort);
    });

    test('should support multiple concurrent ingress streams with dynamic port allocation', async () => {
      const portAllocations: any[] = [];
      
      coordinatorNode.on('message-received', (message: any) => {
        try {
          const data = message.payload?.data;
          if (data && data.type === 'PORT_ALLOCATION_REQUEST') {
            portAllocations.push(data);
          }
        } catch (e) {
          // Ignore non-JSON messages
        }
      });

      // Multiple streams request port allocation
      const streamRequests = [
        { streamId: 'audio-1', mediaType: 'audio', codec: 'opus' },
        { streamId: 'video-1', mediaType: 'video', codec: 'h264' },
        { streamId: 'video-2', mediaType: 'video', codec: 'vp8' }
      ];

      const requestPromises = streamRequests.map(async (stream, index) => {
        const portRequest = new GossipMessage(
          GossipMessageType.DATA,
          ingressInfo,
          {
            type: 'PORT_ALLOCATION_REQUEST',
            streamId: stream.streamId,
            mediaType: stream.mediaType,
            codec: stream.codec,
            nodeId: ingressInfo.id,
            portsNeeded: 2 // media + rtcp
          },
          { recipient: coordinatorInfo }
        );

        return ingressNode.send(portRequest as unknown as Message);
      });

      await Promise.all(requestPromises);
      await new Promise(resolve => setTimeout(resolve, 400));

      expect(portAllocations).toHaveLength(3);
      expect(portAllocations.every(alloc => alloc.portsNeeded === 2)).toBe(true);
    });
  });

  describe('Routing and Processing Coordination', () => {
    test('should signal downstream node to consume and forward media', async () => {
      const processingSignals: any[] = [];
      
      // Establish connection from coordinator to processor
      await coordinatorNode.connect(processorInfo);
      
      // Wait for connection to stabilize
      await new Promise(resolve => setTimeout(resolve, 100));
      
      processorNode.on('message-received', (message: any) => {
        try {
          // Use consistent message parsing
          const data = message.payload?.data;
          if (data && data.type === 'PROCESS_AND_FORWARD') {
            processingSignals.push(data);
          }
        } catch (e) {
          console.log('Error parsing message:', e);
        }
      });

      // Signal processing instruction
      const streamId = 'video-stream-1';
      const processingInstruction = new GossipMessage(
        GossipMessageType.DATA,
        coordinatorInfo,
        {
          type: 'PROCESS_AND_FORWARD',
          streamId: streamId,
          sourceNode: ingressInfo.id,
          sourcePort: 5000,
          targetNode: egressInfo.id,
          targetPort: 6000,
          processing: {
            transcode: true,
            targetCodec: 'vp8',
            targetBitrate: 1000000,
            targetResolution: '1280x720'
          },
          routing: {
            priority: 'high',
            redundancy: false
          }
        },
        { recipient: processorInfo }
      );

      await coordinatorNode.send(processingInstruction as unknown as Message);
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(processingSignals).toHaveLength(1);
      expect(processingSignals[0].streamId).toBe(streamId);
      expect(processingSignals[0].processing.transcode).toBe(true);
      expect(processingSignals[0].targetNode).toBe(egressInfo.id);
    });

    test('should dynamically coordinate route updates for media streams', async () => {
      const portOpenSignals: any[] = [];
      
      egressNode.on('message-received', (message: any) => {
        try {
          // Use consistent message parsing
          const data = message.payload?.data;
          if (data && data.type === 'OPEN_MEDIA_PORT') {
            portOpenSignals.push(data);
          }
        } catch (e) {
          console.log('Error parsing message:', e);
        }
      });

      // Instruct egress node to open specific ports for incoming media
      const portOpenInstruction = new GossipMessage(
        GossipMessageType.DATA,
        processorInfo,
        {
          type: 'OPEN_MEDIA_PORT',
          streamId: 'processed-video-1',
          mediaPort: 7000,
          rtcpPort: 7001,
          protocol: 'rtp',
          sourceNodes: [processorInfo.id],
          encryption: true,
          bufferSize: 1024000,
          timeout: 30000 // 30 seconds
        },
        { recipient: egressInfo }
      );

      await processorNode.send(portOpenInstruction as unknown as Message);
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(portOpenSignals).toHaveLength(1);
      expect(portOpenSignals[0].mediaPort).toBe(7000);
      expect(portOpenSignals[0].rtcpPort).toBe(7001);
      expect(portOpenSignals[0].encryption).toBe(true);
    });
  });

  describe('Processing Node State Synchronization', () => {
    test('should sync processing state across distributed nodes', async () => {
      const stateUpdates: any[] = [];
      
      // Setup state listeners on all nodes
      [ingressNode, processorNode, egressNode].forEach(node => {
        node.on('message-received', (message: any) => {
          try {
            // Use consistent message parsing
            const data = message.payload?.data;
            if (data && data.type === 'STATE_UPDATE') {
              stateUpdates.push(data);
            }
          } catch (e) {
            console.log('Error parsing message:', e);
          }
        });
      });

      // Processing node broadcasts state update
      const stateUpdate = new GossipMessage(
        GossipMessageType.BROADCAST,
        processorInfo,
        {
          type: 'STATE_UPDATE',
          nodeId: processorInfo.id,
          state: {
            activeStreams: 3,
            cpuUsage: 45.2,
            memoryUsage: 67.8,
            bandwidth: {
              incoming: 15000000, // 15 Mbps
              outgoing: 12000000   // 12 Mbps
            },
            ports: {
              allocated: [5000, 5001, 6000, 6001, 7000, 7001],
              available: [8000, 8001, 9000, 9001]
            }
          },
          timestamp: Date.now()
        },
        { 
          priority: 1,
          ttl: 60000
        }
      );

      await processorNode.send(stateUpdate as unknown as Message);
      await new Promise(resolve => setTimeout(resolve, 400));

      // All nodes should receive the state update
      expect(stateUpdates.length).toBeGreaterThanOrEqual(1);
      
      const update = stateUpdates.find(s => s.nodeId === processorInfo.id);
      expect(update).toBeDefined();
      expect(update.state.activeStreams).toBe(3);
      expect(update.state.ports.allocated).toHaveLength(6);
    });

    test('should respond to load and capacity changes in real-time', async () => {
      const capacitySignals: any[] = [];
      
      coordinatorNode.on('message-received', (message: any) => {
        try {
          // Use consistent message parsing
          const data = message.payload?.data;
          if (data && (data.type === 'CAPACITY_WARNING' || data.type === 'CAPACITY_AVAILABLE')) {
            capacitySignals.push(data);
          }
        } catch (e) {
          console.log('Error parsing message:', e);
        }
      });

      // Node signals capacity warning
      const capacityWarning = new GossipMessage(
        GossipMessageType.DATA,
        processorInfo,
        {
          type: 'CAPACITY_WARNING',
          nodeId: processorInfo.id,
          metrics: {
            cpuUsage: 85.5,
            memoryUsage: 92.1,
            activeStreams: 15,
            maxStreams: 20
          },
          recommendation: 'LOAD_BALANCE',
          urgency: 'HIGH'
        },
        { recipient: coordinatorInfo }
      );

      await processorNode.send(capacityWarning as unknown as Message);
      
      // Another node signals availability
      const capacityAvailable = new GossipMessage(
        GossipMessageType.DATA,
        egressInfo,
        {
          type: 'CAPACITY_AVAILABLE',
          nodeId: egressInfo.id,
          metrics: {
            cpuUsage: 25.3,
            memoryUsage: 45.7,
            activeStreams: 2,
            maxStreams: 20
          },
          availableStreams: 18
        },
        { recipient: coordinatorInfo }
      );

      await egressNode.send(capacityAvailable as unknown as Message);
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(capacitySignals).toHaveLength(2);
      expect(capacitySignals.some(s => s.type === 'CAPACITY_WARNING')).toBe(true);
      expect(capacitySignals.some(s => s.type === 'CAPACITY_AVAILABLE')).toBe(true);
    });
  });

  describe('Media Lifecycle Management', () => {
    test('should signal stream teardown and cleanup of associated state', async () => {
      const cleanupSignals: any[] = [];
      
      // Ensure coordinator is connected to receive messages
      await coordinatorNode.connect(processorInfo);
      
      [processorNode, egressNode, coordinatorNode].forEach(node => {
        node.on('message-received', (message: any) => {
          try {
            // Use consistent message parsing
            const data = message.payload?.data;
            if (data && (data.type === 'STREAM_TERMINATE' || data.type === 'PORT_CLEANUP')) {
              cleanupSignals.push(data);
            }
          } catch (e) {
            console.log('Error parsing message:', e);
          }
        });
      });

      const streamId = 'video-stream-to-terminate';
      
      // Signal stream termination
      const terminateSignal = new GossipMessage(
        GossipMessageType.BROADCAST,
        coordinatorInfo,
        {
          type: 'STREAM_TERMINATE',
          streamId: streamId,
          reason: 'CLIENT_DISCONNECT',
          gracefulShutdown: true,
          cleanupPorts: [5000, 5001, 6000, 6001],
          timestamp: Date.now()
        },
        { 
          priority: 1,
          ttl: 60000
        }
      );

      await coordinatorNode.send(terminateSignal as unknown as Message);
      
      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Send port cleanup confirmation from processing node
      const portCleanup = new GossipMessage(
        GossipMessageType.DATA,
        processorInfo,
        {
          type: 'PORT_CLEANUP',
          streamId: streamId,
          nodeId: processorInfo.id,
          portsReleased: [5000, 5001],
          status: 'COMPLETED'
        },
        { recipient: coordinatorInfo }
      );

      await processorNode.send(portCleanup as unknown as Message);
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(cleanupSignals.length).toBeGreaterThanOrEqual(2);
      expect(cleanupSignals.some(s => s.type === 'STREAM_TERMINATE')).toBe(true);
      expect(cleanupSignals.some(s => s.type === 'PORT_CLEANUP')).toBe(true);
    });

    test('should support emergency drain and shutdown signaling', async () => {
      const emergencySignals: any[] = [];
      
      [ingressNode, processorNode, egressNode].forEach(node => {
        node.on('message-received', (message: any) => {
          try {
            // Use consistent message parsing
            const data = message.payload?.data;
            if (data && data.type === 'EMERGENCY_SHUTDOWN') {
              emergencySignals.push(data);
            }
          } catch (e) {
            console.log('Error parsing message:', e);
          }
        });
      });

      // Coordinator signals emergency shutdown
      const emergencyShutdown = new GossipMessage(
        GossipMessageType.BROADCAST,
        coordinatorInfo,
        {
          type: 'EMERGENCY_SHUTDOWN',
          reason: 'SYSTEM_OVERLOAD',
          affectedNodes: [ingressInfo.id, processorInfo.id, egressInfo.id],
          shutdownSequence: [
            { nodeId: ingressInfo.id, action: 'STOP_INGESTION', delay: 0 },
            { nodeId: processorInfo.id, action: 'FLUSH_PROCESSING', delay: 1000 },
            { nodeId: egressInfo.id, action: 'CLOSE_OUTPUTS', delay: 2000 }
          ],
          timestamp: Date.now()
        },
        { 
          priority: 1,
          ttl: 60000
        }
      );

      await coordinatorNode.send(emergencyShutdown as unknown as Message);
      await new Promise(resolve => setTimeout(resolve, 400));

      expect(emergencySignals.length).toBeGreaterThanOrEqual(1);
      
      const shutdown = emergencySignals[0];
      expect(shutdown.reason).toBe('SYSTEM_OVERLOAD');
      expect(shutdown.shutdownSequence).toHaveLength(3);
      expect(shutdown.affectedNodes).toContain(ingressInfo.id);
    });
  });

  describe('Signaling Throughput and Responsiveness', () => {
    test('should handle bursty signaling updates under load', async () => {
      const signalCount = 50;
      const signals: any[] = [];
      
      processorNode.on('message-received', (message: any) => {
        try {
          // Use consistent message parsing
          const data = message.payload?.data;
          if (data && data.type === 'REAL_TIME_METRIC') {
            signals.push(data);
          }
        } catch (e) {
          console.log('Error parsing message:', e);
        }
      });

      // Simulate high-frequency real-time metrics
      const metricPromises: Promise<void>[] = [];
      const startTime = Date.now();
      
      for (let i = 0; i < signalCount; i++) {
        const metric = new GossipMessage(
          GossipMessageType.DATA,
          ingressInfo,
          {
            type: 'REAL_TIME_METRIC',
            streamId: 'live-stream-1',
            sequenceNumber: i,
            metrics: {
              frameRate: 30 + Math.random() * 5,
              bitrate: 2000000 + Math.random() * 500000,
              packetLoss: Math.random() * 0.01,
              jitter: Math.random() * 10,
              timestamp: Date.now()
            }
          },
          { recipient: processorInfo }
        );

        metricPromises.push(
          ingressNode.send(metric as unknown as Message)
            .catch(() => {}) // Ignore individual failures in high-frequency test
        );
        
        // Small delay to prevent overwhelming
        if (i % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }

      await Promise.allSettled(metricPromises);
      const duration = Date.now() - startTime;
      
      // Allow processing time
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Should handle most signals efficiently
      expect(duration).toBeLessThan(5000); // Complete within 5 seconds
      expect(signals.length).toBeGreaterThan(signalCount * 0.7); // At least 70% success rate
    });
  });

  describe('Load Coordination and Redundancy', () => {
    test('should rebalance processing when node availability changes', async () => {
      const loadBalanceSignals: any[] = [];
      
      coordinatorNode.on('message-received', (message: any) => {
        try {
          // Use consistent message parsing
          const data = message.payload?.data;
          if (data && data.type === 'LOAD_BALANCE_REQUEST') {
            loadBalanceSignals.push(data);
          }
        } catch (e) {
          console.log('Error parsing message:', e);
        }
      });

      // Node requests load balancing due to high load
      const loadBalanceRequest = new GossipMessage(
        GossipMessageType.DATA,
        processorInfo,
        {
          type: 'LOAD_BALANCE_REQUEST',
          sourceNode: processorInfo.id,
          currentLoad: {
            activeStreams: 18,
            cpuUsage: 88.5,
            memoryUsage: 91.2
          },
          streamsToMigrate: [
            { streamId: 'video-1', priority: 'low', size: 1500000 },
            { streamId: 'video-2', priority: 'medium', size: 2000000 }
          ],
          preferredTargets: [egressInfo.id]
        },
        { recipient: coordinatorInfo }
      );

      await processorNode.send(loadBalanceRequest as unknown as Message);
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(loadBalanceSignals).toHaveLength(1);
      expect(loadBalanceSignals[0].streamsToMigrate).toHaveLength(2);
      expect(loadBalanceSignals[0].preferredTargets).toContain(egressInfo.id);
    });
  });
});
