/**
 * Minimal Cluster Test
 * 
 * Simple test to verify ClusterManager can start without complex setup
 */

import { describe, test, beforeEach, afterEach, expect } from '@jest/globals';
import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { BootstrapConfig } from '../../../src/config/BootstrapConfig';
import { TCPAdapter } from '../../../src/transport/adapters/TCPAdapter';
import { NodeInfo } from '../../../src/cluster/types';
import { NodeId } from '../../../src/types';

describe('Minimal Cluster Test', () => {
  const TEST_TIMEOUT = 15000;
  
  let clusterManager: ClusterManager;
  let transport: TCPAdapter;

  beforeEach(async () => {
    // Allocate a test port
    const port = (global as any).allocatePort('cluster');

    // Create a single node
    const nodeInfo: NodeInfo = {
      id: 'test-node-1',
      version: 1,
      status: 'ALIVE',
      lastSeen: Date.now(),
      metadata: { 
        address: '127.0.0.1',
        port: port,
        role: 'bootstrap', 
        zone: 'test-zone' 
      }
    };

    // Create NodeId for transport
    const nodeId: NodeId = {
      id: 'test-node-1',
      address: '127.0.0.1',
      port: port
    };

    // Create transport
    transport = new TCPAdapter(nodeId, {
      port: port,
      enableLogging: false,
      connectionTimeout: 5000,
      maxRetries: 3,
      baseRetryDelay: 1000
    });

    // Create bootstrap config (no seed nodes - bootstrap node)
    const config = BootstrapConfig.create({
      seedNodes: [],
      joinTimeout: 10000,
      gossipInterval: 2000,
      enableLogging: false,
      failureDetector: {
        heartbeatInterval: 3000,
        failureTimeout: 6000,
        deadTimeout: 12000,
        maxMissedHeartbeats: 2,
        enableActiveProbing: false,
        enableLogging: false
      },
      lifecycle: {
        shutdownTimeout: 5000,
        drainTimeout: 2000,
        enableAutoRebalance: false,
        rebalanceThreshold: 0.2,
        enableGracefulShutdown: true,
        maxShutdownWait: 3000
      }
    });

    // Create ClusterManager
    clusterManager = new ClusterManager(
      nodeInfo.id,
      transport,
      config,
      25 // minimal virtual nodes
    );

    // Register cleanup
    (global as any).addCleanupTask(async () => {
      if (clusterManager) {
        try {
          await clusterManager.stop();
        } catch (e) {
          console.log('Cleanup error:', e);
        }
      }
    });
  }, TEST_TIMEOUT);

  afterEach(async () => {
    if (clusterManager) {
      try {
        await clusterManager.stop();
      } catch (e) {
        console.log('AfterEach cleanup error:', e);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  });

  test('should start single cluster node successfully', async () => {
    console.log('Starting single cluster node...');
    
    // Start the cluster manager
    await clusterManager.start();
    
    console.log('Cluster manager started');
    
    // Verify it started
    expect(clusterManager).toBeDefined();
    
    // Check basic state
    const memberCount = clusterManager.getMemberCount();
    console.log('Member count:', memberCount);
    
    const aliveMembers = clusterManager.membership.getAliveMembers();
    console.log('Alive members:', aliveMembers.map(m => m.id));
    
    // Should have at least itself as a member
    expect(aliveMembers.length).toBeGreaterThanOrEqual(1);
    expect(aliveMembers.some(m => m.id === 'test-node-1')).toBe(true);
    
    // Check hash ring
    const ringNodes = clusterManager.hashRing.getAllNodes();
    console.log('Ring nodes:', ringNodes);
    expect(ringNodes.length).toBeGreaterThanOrEqual(1);
    
    console.log('Single node test completed successfully');
    
  }, TEST_TIMEOUT);
});
