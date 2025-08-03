/**
 * Performance Test Helpers
 * 
 * Utilities for measuring and validating performance characteristics
 * of distributed cluster operations.
 */

import { ClusterManager } from '../../../src/cluster/ClusterManager';
import { RangeCoordinator } from '../../../src/coordinators/RangeCoordinator';
import { ClusterTestNode } from './clusterTestHelpers';
import { ClusterMessage } from '../../../src/coordinators/types';

export interface PerformanceMetrics {
  startTime: number;
  endTime: number;
  duration: number;
  throughput?: number;
  latency?: number;
  successCount: number;
  failureCount: number;
  operationsPerSecond?: number;
}

/**
 * Measure message throughput between sender and receiver
 */
export async function measureMessageThroughput(
  sender: any, // TCPAdapter or similar
  receiver: any,
  messageCount: number
): Promise<PerformanceMetrics> {
  const startTime = Date.now();
  let successCount = 0;
  let failureCount = 0;

  const receivedMessages: any[] = [];
  
  // Setup receiver to count messages
  receiver.onMessage((message: any) => {
    receivedMessages.push(message);
  });

  // Send messages as fast as possible
  const sendPromises: Promise<void>[] = [];
  
  for (let i = 0; i < messageCount; i++) {
    const message = {
      id: `perf-test-${i}`,
      type: 'performance-test',
      data: { sequence: i, payload: 'test-data' },
      sender: sender.nodeInfo || { id: 'sender', address: '127.0.0.1', port: 0 },
      timestamp: Date.now()
    };

    const sendPromise = sender.send(message, receiver.nodeInfo || { id: 'receiver', address: '127.0.0.1', port: 0 })
      .then(() => successCount++)
      .catch(() => failureCount++);
      
    sendPromises.push(sendPromise);
  }

  // Wait for all sends to complete
  await Promise.allSettled(sendPromises);
  
  // Wait a bit for message processing
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const endTime = Date.now();
  const duration = endTime - startTime;
  const throughput = receivedMessages.length / (duration / 1000); // messages per second

  return {
    startTime,
    endTime,
    duration,
    throughput,
    successCount,
    failureCount,
    operationsPerSecond: throughput
  };
}

/**
 * Measure cluster formation time
 */
export async function measureClusterFormationTime(
  nodes: ClusterTestNode[]
): Promise<PerformanceMetrics> {
  const startTime = Date.now();
  let successCount = 0;
  let failureCount = 0;

  try {
    // Start all nodes concurrently
    const startPromises = nodes.map(async (node) => {
      if (node.clusterManager) {
        await node.clusterManager.start();
        node.isStarted = true;
        successCount++;
      }
    });

    await Promise.allSettled(startPromises);

    // Wait for cluster convergence
    let converged = false;
    const convergenceTimeout = 30000; // 30 seconds
    const convergenceStartTime = Date.now();

    while (!converged && (Date.now() - convergenceStartTime) < convergenceTimeout) {
      converged = true;
      
      for (const node of nodes) {
        if (!node.clusterManager || !node.isStarted) {
          converged = false;
          break;
        }

        const aliveMembers = node.clusterManager.membership.getAliveMembers();
        if (aliveMembers.length !== nodes.length) {
          converged = false;
          break;
        }
      }

      if (!converged) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    if (!converged) {
      failureCount = nodes.length;
      throw new Error('Cluster failed to converge within timeout');
    }

  } catch (error) {
    failureCount = nodes.length;
    throw error;
  }

  const endTime = Date.now();
  const duration = endTime - startTime;

  return {
    startTime,
    endTime,
    duration,
    successCount,
    failureCount,
    operationsPerSecond: successCount / (duration / 1000)
  };
}

/**
 * Measure failure detection time
 */
export async function measureFailureDetectionTime(
  cluster: ClusterTestNode[],
  failedNode: ClusterTestNode
): Promise<PerformanceMetrics> {
  const startTime = Date.now();
  let successCount = 0;
  let failureCount = 0;

  try {
    // Stop the target node
    if (failedNode.clusterManager && failedNode.isStarted) {
      await failedNode.clusterManager.stop();
      failedNode.isStarted = false;
    }

    // Wait for other nodes to detect the failure
    const detectionTimeout = 15000; // 15 seconds
    let detected = false;

    while (!detected && (Date.now() - startTime) < detectionTimeout) {
      detected = true;

      for (const node of cluster) {
        if (node === failedNode || !node.clusterManager || !node.isStarted) {
          continue;
        }

        const aliveMembers = node.clusterManager.membership.getAliveMembers();
        const failedNodeStillSeen = aliveMembers.some(member => member.id === failedNode.nodeInfo.id);
        
        if (failedNodeStillSeen) {
          detected = false;
          break;
        }
      }

      if (!detected) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    if (detected) {
      successCount = 1;
    } else {
      failureCount = 1;
      throw new Error('Failure detection timeout');
    }

  } catch (error) {
    failureCount = 1;
    throw error;
  }

  const endTime = Date.now();
  const duration = endTime - startTime;

  return {
    startTime,
    endTime,
    duration,
    successCount,
    failureCount,
    latency: duration
  };
}

/**
 * Collect comprehensive performance metrics from cluster
 */
export function collectPerformanceMetrics(
  cluster: ClusterTestNode[] | RangeCoordinator[],
  duration: number
): PerformanceMetrics {
  const startTime = Date.now() - duration;
  const endTime = Date.now();

  let successCount = 0;
  let failureCount = 0;

  // Collect metrics from cluster nodes
  if (cluster.length > 0 && 'clusterManager' in cluster[0]) {
    // Handle ClusterTestNode[]
    const clusterNodes = cluster as ClusterTestNode[];
    
    for (const node of clusterNodes) {
      if (node.clusterManager && node.isStarted) {
        successCount++;
        
        // Collect additional metrics from transport layer if available
        try {
          // This would collect transport statistics, gossip metrics, etc.
          // const transportStats = node.clusterManager.transport.getStats();
          // const gossipStats = node.clusterManager.gossipStrategy.getStats();
        } catch (error) {
          failureCount++;
        }
      } else {
        failureCount++;
      }
    }
  } else {
    // Handle RangeCoordinator[]
    const coordinators = cluster as RangeCoordinator[];
    
    for (const coordinator of coordinators) {
      try {
        // Collect metrics from coordinator
        // const coordinatorStats = coordinator.getStats();
        successCount++;
      } catch (error) {
        failureCount++;
      }
    }
  }

  return {
    startTime,
    endTime,
    duration,
    successCount,
    failureCount,
    operationsPerSecond: successCount / (duration / 1000)
  };
}

/**
 * Performance test runner with configurable parameters
 */
export async function runPerformanceTest(
  testName: string,
  testFunction: () => Promise<PerformanceMetrics>,
  expectedThresholds?: {
    maxDuration?: number;
    minThroughput?: number;
    maxLatency?: number;
    minSuccessRate?: number;
  }
): Promise<PerformanceMetrics> {
  console.log(`Starting performance test: ${testName}`);
  
  const metrics = await testFunction();
  
  console.log(`Performance test ${testName} completed:`, {
    duration: `${metrics.duration}ms`,
    throughput: metrics.throughput ? `${metrics.throughput.toFixed(2)} ops/sec` : 'N/A',
    latency: metrics.latency ? `${metrics.latency}ms` : 'N/A',
    successRate: `${(metrics.successCount / (metrics.successCount + metrics.failureCount) * 100).toFixed(1)}%`
  });

  // Validate against thresholds if provided
  if (expectedThresholds) {
    const successRate = metrics.successCount / (metrics.successCount + metrics.failureCount);
    
    if (expectedThresholds.maxDuration && metrics.duration > expectedThresholds.maxDuration) {
      throw new Error(`Test ${testName} exceeded maximum duration: ${metrics.duration}ms > ${expectedThresholds.maxDuration}ms`);
    }
    
    if (expectedThresholds.minThroughput && metrics.throughput && metrics.throughput < expectedThresholds.minThroughput) {
      throw new Error(`Test ${testName} below minimum throughput: ${metrics.throughput} < ${expectedThresholds.minThroughput} ops/sec`);
    }
    
    if (expectedThresholds.maxLatency && metrics.latency && metrics.latency > expectedThresholds.maxLatency) {
      throw new Error(`Test ${testName} exceeded maximum latency: ${metrics.latency}ms > ${expectedThresholds.maxLatency}ms`);
    }
    
    if (expectedThresholds.minSuccessRate && successRate < expectedThresholds.minSuccessRate) {
      throw new Error(`Test ${testName} below minimum success rate: ${(successRate * 100).toFixed(1)}% < ${(expectedThresholds.minSuccessRate * 100).toFixed(1)}%`);
    }
  }

  return metrics;
}
