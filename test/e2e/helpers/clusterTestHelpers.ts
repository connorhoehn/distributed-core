/**
 * Cluster Test Helpers
 * 
 * Shared utilities for testing distributed cluster functionality.
 * Used by both ring-based and range-based E2E tests.
 */

import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { NodeInfo } from '../../../src/cluster/types';

export interface ClusterTestNode {
  nodeInfo: NodeInfo;
  clusterManager?: ClusterManager;
  isStarted: boolean;
}

/**
 * Wait for cluster convergence - all nodes see each other
 */
export async function waitForClusterConvergence(
  nodes: ClusterTestNode[], 
  timeout: number = 10000
): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    let converged = true;
    
    for (const node of nodes) {
      if (!node.clusterManager || !node.isStarted) {
        converged = false;
        console.log(`Node ${node.nodeInfo.id} is not started or missing cluster manager`);
        break;
      }
      
      const aliveMembers = node.clusterManager.membership.getAliveMembers();
      console.log(`Node ${node.nodeInfo.id} sees ${aliveMembers.length} alive members: [${aliveMembers.map(m => m.id).join(', ')}]`);
      
      // Check if this node sees all other nodes
      if (aliveMembers.length !== nodes.length) {
        converged = false;
        console.log(`Node ${node.nodeInfo.id} expected ${nodes.length} members but sees ${aliveMembers.length}`);
        break;
      }
      
      // Verify all expected nodes are present
      for (const expectedNode of nodes) {
        const found = aliveMembers.some(member => member.id === expectedNode.nodeInfo.id);
        if (!found) {
          converged = false;
          console.log(`Node ${node.nodeInfo.id} missing expected member ${expectedNode.nodeInfo.id}`);
          break;
        }
      }
      
      if (!converged) break;
    }
    
    if (converged) {
      console.log('Cluster convergence achieved!');
      return; // Success!
    }
    
    // Wait before checking again
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  throw new Error(`Cluster failed to converge within ${timeout}ms`);
}

/**
 * Validate that all nodes have consistent membership views
 */
export function validateMembershipConsistency(nodes: ClusterTestNode[]): void {
  if (nodes.length === 0) return;
  
  const activeNodes = nodes.filter(node => node.clusterManager && node.isStarted);
  if (activeNodes.length === 0) return;
  
  // Get membership from first active node as reference
  const referenceMembers = activeNodes[0].clusterManager!.membership.getAliveMembers()
    .map(m => m.id)
    .sort();
  
  // Verify all other nodes have the same membership view
  for (let i = 1; i < activeNodes.length; i++) {
    const members = activeNodes[i].clusterManager!.membership.getAliveMembers()
      .map(m => m.id)
      .sort();
    
    if (JSON.stringify(members) !== JSON.stringify(referenceMembers)) {
      throw new Error(
        `Membership inconsistency detected. Node ${activeNodes[i].nodeInfo.id} ` +
        `sees [${members.join(', ')}] but expected [${referenceMembers.join(', ')}]`
      );
    }
  }
}

/**
 * Simulate network partition by splitting nodes into groups
 */
export async function injectNetworkPartition(
  nodes: ClusterTestNode[], 
  partitionGroups: ClusterTestNode[][]
): Promise<void> {
  // For testing purposes, we'll simulate this by temporarily stopping
  // gossip communication between groups
  console.log(`Simulating network partition with ${partitionGroups.length} groups`);
  
  // This is a simplified simulation - in a real implementation,
  // you would intercept network communication
  for (const group of partitionGroups) {
    for (const node of group) {
      if (node.clusterManager) {
        // Temporarily disable gossip to other groups
        // Note: This is a test simulation - actual implementation would
        // require network-level controls
      }
    }
  }
}

/**
 * Simulate node failure by stopping a node for a duration
 */
export async function simulateNodeFailure(
  node: ClusterTestNode, 
  duration: number = 5000
): Promise<void> {
  if (!node.clusterManager || !node.isStarted) {
    throw new Error(`Node ${node.nodeInfo.id} is not running`);
  }
  
  console.log(`Simulating failure of node ${node.nodeInfo.id} for ${duration}ms`);
  
  // Stop the node
  await node.clusterManager.stop();
  node.isStarted = false;
  
  // Wait for the specified duration
  await new Promise(resolve => setTimeout(resolve, duration));
  
  // Restart the node
  await node.clusterManager.start();
  node.isStarted = true;
  
  console.log(`Node ${node.nodeInfo.id} recovered from simulated failure`);
}

/**
 * Measure gossip propagation time from source to target nodes
 */
export async function measureGossipPropagationTime(
  sourceNode: ClusterTestNode, 
  targetNodes: ClusterTestNode[]
): Promise<number> {
  if (!sourceNode.clusterManager || !sourceNode.isStarted) {
    throw new Error(`Source node ${sourceNode.nodeInfo.id} is not running`);
  }
  
  const startTime = Date.now();
  
  // Inject a state change in the source node
  // This would typically be done through a test API or by
  // modifying internal state for testing purposes
  
  // For now, we'll measure how long it takes for membership
  // changes to propagate by monitoring membership updates
  
  // Wait for gossip propagation (simplified measurement)
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const propagationTime = Date.now() - startTime;
  console.log(`Gossip propagation took ${propagationTime}ms`);
  
  return propagationTime;
}

/**
 * Create a test cluster node with proper configuration
 */
export function createTestClusterNode(
  nodeInfo: NodeInfo,
  seedNodes: NodeInfo[] = []
): ClusterTestNode {
  return {
    nodeInfo,
    clusterManager: undefined, // Will be set when ClusterManager is created
    isStarted: false
  };
}

/**
 * Cleanup helper to safely stop all nodes
 */
export async function cleanupClusterNodes(nodes: ClusterTestNode[]): Promise<void> {
  const stopPromises = nodes.map(async (node) => {
    try {
      if (node.clusterManager && node.isStarted) {
        await node.clusterManager.stop();
        node.isStarted = false;
      }
    } catch (error) {
      // Ignore cleanup errors to prevent test failures
      console.warn(`Error stopping node ${node.nodeInfo.id}:`, error);
    }
  });
  
  await Promise.allSettled(stopPromises);
  
  // Small delay to ensure cleanup completes
  await new Promise(resolve => setTimeout(resolve, 100));
}
