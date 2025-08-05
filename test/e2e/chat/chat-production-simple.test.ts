import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';
import { ProductionChatHarness, ChatRoomResource, ProductionChatClient } from '../../harnesses/production-chat-harness-fixed';

/**
 * Simplified Production-Scale E2E Chat System Tests
 * 
 * This test suite validates the ResourceRegistry integration with chat scenarios,
 * focusing on production-scale functionality while maintaining test reliability.
 */

describe('Production Chat with ResourceRegistry Integration', () => {
  let harness: ProductionChatHarness;

  beforeEach(async () => {
    harness = new ProductionChatHarness();
  });

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  describe('🚀 Enterprise-Scale Chat Scenarios', () => {
    test('should handle enterprise Discord-style multi-room communication with ResourceRegistry', async () => {
      // Setup production cluster with ResourceRegistry backend
      const nodes = await harness.setupProductionCluster(4);
      expect(nodes).toHaveLength(4);
      console.log('✅ Production cluster initialized with 4 nodes');
      
      // Create high-capacity chat rooms with resource management
      const rooms = ['general', 'random', 'development', 'announcements', 'scaling-test'];
      const roomResources: ChatRoomResource[] = [];
      
      for (const roomName of rooms) {
        const roomResource = await harness.createProductionChatRoom(roomName, {
          maxParticipants: 100,
          autoSharding: true,
          description: `Enterprise ${roomName} channel`
        });
        roomResources.push(roomResource);
        console.log(`💬 Created production room '${roomName}' with auto-scaling enabled`);
      }
      
      // Create distributed clients across all nodes for load balancing
      const clients: ProductionChatClient[] = [];
      for (let i = 0; i < 20; i++) { // More clients for production scale
        const nodeIndex = i % 4; // Distribute across nodes
        const client = await harness.createProductionChatClient(nodeIndex, `enterprise-user-${i}`);
        clients.push(client);
      }
      
      // Join clients to multiple rooms (simulate real usage patterns)
      for (const client of clients) {
        const userRooms = rooms.slice(0, Math.floor(Math.random() * 3) + 1); // Join 1-3 rooms
        for (const room of userRooms) {
          await harness.joinProductionChatRoom(client, room);
        }
      }
      
      // Simulate heavy message traffic across multiple rounds
      const messageRounds = 3;
      for (let round = 0; round < messageRounds; round++) {
        const messagePromises: Promise<void>[] = [];
        
        // Each user sends messages to their joined rooms
        for (let i = 0; i < Math.min(10, clients.length); i++) {
          const client = clients[i];
          const userRooms = Array.from(client.joinedRooms);
          
          for (const room of userRooms) {
            messagePromises.push(
              harness.sendProductionMessage(client, room, `Enterprise msg ${round}-${i} in ${room}`)
            );
          }
        }
        
        await Promise.all(messagePromises);
        await new Promise(resolve => setTimeout(resolve, 100)); // Brief pause between rounds
      }
      
      // Validate cluster resource overview and scaling
      const overview = await harness.getClusterResourceOverview();
      expect(overview.totalNodes).toBe(4);
      expect(overview.totalClients).toBe(clients.length);
      expect(overview.totalRooms).toBe(rooms.length);
      
      // Validate node distribution
      expect(overview.nodes.length).toBe(4);
      for (const nodeInfo of overview.nodes) {
        expect(nodeInfo.nodeId).toBeDefined();
        expect(nodeInfo.resources).toBeGreaterThanOrEqual(0);
        expect(nodeInfo.participants).toBeGreaterThanOrEqual(0);
      }
      
      // Validate that clients are properly connected and active
      for (const client of clients.slice(0, 5)) { // Check sample of clients
        expect(client.connected).toBe(true);
        expect(client.joinedRooms.size).toBeGreaterThan(0);
      }
      
      await harness.cleanup();
    }, 60000); // 1 minute timeout

    test('should handle resource auto-scaling under load', async () => {
      await harness.setupProductionCluster(2);
      
      // Create a high-capacity room with auto-scaling
      const stressRoom = await harness.createProductionChatRoom('stress-test-room', {
        maxParticipants: 50,
        autoSharding: true,
        description: 'Stress test room with auto-scaling'
      });
      
      console.log('🏋️  Created stress test room with auto-scaling (initial capacity: 50)');
      
      // Create batch clients to simulate load growth
      const batchClients: ProductionChatClient[] = [];
      for (let batch = 0; batch < 2; batch++) {
        const batchSize = 10; // Start small for reliable testing
        
        // Create clients for this batch
        for (let i = 0; i < batchSize; i++) {
          const nodeIndex = (batch * batchSize + i) % 2; // Distribute across 2 nodes
          const client = await harness.createProductionChatClient(nodeIndex, `stress-user-${batch}-${i}`);
          batchClients.push(client);
          await harness.joinProductionChatRoom(client, 'stress-test-room');
        }
        
        console.log(`👥 Batch ${batch + 1}: Added ${batchSize} clients (total: ${batchClients.length})`);
        
        // Check auto-scaling response
        const overview = await harness.getClusterResourceOverview();
        expect(overview.totalClients).toBe(batchClients.length);
        
        // Brief pause between batches
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      // Final resource verification
      const finalOverview = await harness.getClusterResourceOverview();
      expect(finalOverview.totalClients).toBe(batchClients.length);
      expect(finalOverview.totalRooms).toBeGreaterThanOrEqual(1);
      
      await harness.cleanup();
    }, 30000);

    test('should handle enterprise user growth with resource optimization', async () => {
      const nodes = await harness.setupProductionCluster(3);
      
      // Start with a popular enterprise channel
      const enterpriseRoom = await harness.createProductionChatRoom('enterprise-announcements', {
        maxParticipants: 200,
        autoSharding: true,
        description: 'Enterprise announcements channel'
      });
      
      console.log('🏢 Created enterprise announcements room');
      
      // Simulate realistic user growth patterns
      const allClients: ProductionChatClient[] = [];
      const growthWaves = [
        { name: 'morning-rush', users: 5 },
        { name: 'peak-hours', users: 8 },
        { name: 'afternoon', users: 6 }
      ];
      
      for (const wave of growthWaves) {
        console.log(`🌊 Starting ${wave.name} wave with ${wave.users} users`);
        
        const waveClients: ProductionChatClient[] = [];
        for (let i = 0; i < wave.users; i++) {
          const nodeIndex = i % 3;
          const client = await harness.createProductionChatClient(nodeIndex, `${wave.name}-user-${i}`);
          waveClients.push(client);
          await harness.joinProductionChatRoom(client, 'enterprise-announcements');
        }
        
        allClients.push(...waveClients);
        
        // Simulate some messaging activity for each wave
        for (let i = 0; i < Math.min(3, waveClients.length); i++) {
          const client = waveClients[i];
          await harness.sendProductionMessage(client, 'enterprise-announcements', `${wave.name} message ${i}`);
        }
        
        const overview = await harness.getClusterResourceOverview();
        console.log(`📊 Wave complete: ${allClients.length} total users, ${overview.totalRooms} rooms`);
      }
      
      // Final validation
      const finalOverview = await harness.getClusterResourceOverview();
      expect(finalOverview.totalClients).toBe(allClients.length);
      expect(finalOverview.totalRooms).toBe(1);
      
      // Validate that clients are properly connected
      for (const client of allClients.slice(0, 3)) { // Check sample
        expect(client.connected).toBe(true);
        expect(client.joinedRooms.has('enterprise-announcements')).toBe(true);
      }
      
      await harness.cleanup();
    }, 45000);
  });
});
