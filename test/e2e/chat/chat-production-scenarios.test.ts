import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';
import { MultiRoomChatHarness, MultiRoomClient } from '../../integration/chat/multi-room-chat-integration.test';

/**
 * End-to-End Chat System Tests
 * 
 * 🎯 E2E TEST SUITE - Comprehensive real-world scenarios
 * 
 * These tests validate the complete chat system behavior under realistic conditions:
 * - Multi-node distributed chat with realistic message volumes
 * - Complex cross-room communication patterns
 * - Production-like concurrent operations
 * - Long-running stability tests
 */

describe('Chat System E2E Tests', () => {
  let harness: MultiRoomChatHarness;

  beforeEach(async () => {
    harness = new MultiRoomChatHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('🚀 Production-Scale Chat Scenarios', () => {
    test('should handle realistic Discord-style multi-room communication', async () => {
      await harness.setupCluster(3);
      
      // Create multiple clients across different nodes to simulate real usage
      const clients: MultiRoomClient[] = [];
      for (let i = 0; i < 5; i++) {
        const nodeIndex = i % 3; // Distribute across nodes
        const client = await harness.createMultiRoomClient(nodeIndex, `user-${i}`);
        clients.push(client);
      }
      
      // Each client joins multiple rooms (like Discord servers)
      const rooms = ['general', 'random', 'announcements', 'development', 'offtopic'];
      for (const client of clients) {
        for (const room of rooms) {
          await harness.joinRoom(client, room);
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for all joins
      
      // Simulate realistic chat activity
      for (let round = 0; round < 10; round++) {
        const promises: Promise<void>[] = [];
        for (let i = 0; i < clients.length; i++) {
          const client = clients[i];
          const room = rooms[Math.floor(Math.random() * rooms.length)];
          promises.push(
            harness.sendMessage(client, room, `Message ${round}-${i} in ${room}`)
          );
        }
        await Promise.all(promises);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for message propagation
      
      // Verify all clients received messages
      for (const client of clients) {
        const messageCount = client.receivedMessages.filter(msg => msg.type === 'message').length;
        expect(messageCount).toBeGreaterThan(0);
        expect(client.joinedRooms.size).toBe(rooms.length);
      }
      
      console.log('✅ Production-scale multi-room chat completed successfully');
    }, 15000); // E2E: Production-scale Discord simulation

    test('should maintain consistency under high concurrent load', async () => {
      await harness.setupCluster(4);
      
      // Create many clients for stress testing
      const clients: MultiRoomClient[] = [];
      for (let i = 0; i < 10; i++) {
        const nodeIndex = i % 4;
        const client = await harness.createMultiRoomClient(nodeIndex, `stress-user-${i}`);
        clients.push(client);
      }
      
      // All join the same room for maximum conflict potential
      const testRoom = 'stress-test-room';
      for (const client of clients) {
        await harness.joinRoom(client, testRoom);
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Concurrent message burst from all clients
      const messagePromises: Promise<void>[] = [];
      for (let i = 0; i < clients.length; i++) {
        for (let j = 0; j < 5; j++) {
          messagePromises.push(
            harness.sendMessage(clients[i], testRoom, `Concurrent msg ${i}-${j}`)
          );
        }
      }
      
      await Promise.all(messagePromises);
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for all propagation
      
      // Verify message consistency across all clients
      const messageCounts = clients.map(client => 
        client.receivedMessages.filter(msg => msg.type === 'message').length
      );
      
      // All clients should have received roughly the same number of messages
      const avgMessages = messageCounts.reduce((a, b) => a + b, 0) / messageCounts.length;
      for (const count of messageCounts) {
        expect(Math.abs(count - avgMessages)).toBeLessThan(avgMessages * 0.3); // Within 30%
      }
      
      console.log('✅ High concurrent load test passed with consistent message delivery');
    }, 20000); // E2E: High concurrency stress test

    test('should handle extended chat session with gradual user growth', async () => {
      await harness.setupCluster(2);
      
      // Start with few users
      const initialClients: MultiRoomClient[] = [];
      for (let i = 0; i < 3; i++) {
        const client = await harness.createMultiRoomClient(i % 2, `early-user-${i}`);
        initialClients.push(client);
      }
      
      // Everyone joins a popular room
      const mainRoom = 'popular-channel';
      for (const client of initialClients) {
        await harness.joinRoom(client, mainRoom);
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Send initial messages
      for (let i = 0; i < initialClients.length; i++) {
        await harness.sendMessage(initialClients[i], mainRoom, `Initial message ${i}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Gradual user growth (simulating growing chat popularity)
      const allClients = [...initialClients];
      for (let wave = 0; wave < 3; wave++) {
        const newClient = await harness.createMultiRoomClient(wave % 2, `late-user-${wave}`);
        allClients.push(newClient);
        await harness.joinRoom(newClient, mainRoom);
        
        // New user sends message
        await harness.sendMessage(newClient, mainRoom, `New user wave ${wave}`);
        
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Verify all users are properly connected and receiving messages
      for (const client of allClients) {
        expect(client.connected).toBe(true);
        expect(client.joinedRooms.has(mainRoom)).toBe(true);
      }
      
      console.log('✅ Extended chat session with user growth completed successfully');
    }, 12000); // E2E: Extended session simulation
  });
});

// Export the test harness for reuse
export { MultiRoomChatHarness };
