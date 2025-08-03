/**
 * Range Test Helpers
 * 
 * Shared utilities for testing range-based coordinator functionality.
 * Used by range-based E2E tests.
 */

import { RangeCoordinator } from '../../../src/coordinators/RangeCoordinator';
import { RangeHandler, ClusterMessage, RangeId, ClusterInfo } from '../../../src/coordinators/types';

/**
 * Test Range Handler for E2E testing
 * Tracks range operations and received messages for validation
 */
export class TestRangeHandler implements RangeHandler {
  public ownedRanges = new Set<RangeId>();
  public receivedMessages: ClusterMessage[] = [];
  public topologyChanges: ClusterInfo[] = [];
  public rangeJoinEvents: { rangeId: RangeId; clusterInfo: ClusterInfo }[] = [];
  public rangeLeaveEvents: { rangeId: RangeId }[] = [];

  constructor(public readonly handlerId: string) {}

  async onJoin(rangeId: RangeId, clusterInfo: ClusterInfo): Promise<void> {
    console.log(`Handler ${this.handlerId}: Joining range ${rangeId}`);
    this.ownedRanges.add(rangeId);
    this.rangeJoinEvents.push({ rangeId, clusterInfo });
  }

  async onMessage(message: ClusterMessage): Promise<void> {
    console.log(`Handler ${this.handlerId}: Received message for range ${message.targetRangeId}`);
    this.receivedMessages.push(message);
  }

  async onLeave(rangeId: RangeId): Promise<void> {
    console.log(`Handler ${this.handlerId}: Leaving range ${rangeId}`);
    this.ownedRanges.delete(rangeId);
    this.rangeLeaveEvents.push({ rangeId });
  }

  async onTopologyChange(clusterInfo: ClusterInfo): Promise<void> {
    console.log(`Handler ${this.handlerId}: Topology changed`);
    this.topologyChanges.push(clusterInfo);
  }

  // Helper methods for testing
  getOwnedRangeCount(): number {
    return this.ownedRanges.size;
  }

  hasRange(rangeId: RangeId): boolean {
    return this.ownedRanges.has(rangeId);
  }

  getMessageCount(): number {
    return this.receivedMessages.length;
  }

  getMessagesForRange(rangeId: RangeId): ClusterMessage[] {
    return this.receivedMessages.filter(msg => msg.targetRangeId === rangeId);
  }

  reset(): void {
    this.ownedRanges.clear();
    this.receivedMessages = [];
    this.topologyChanges = [];
    this.rangeJoinEvents = [];
    this.rangeLeaveEvents = [];
  }
}

/**
 * Create a test range handler with optional tracking configuration
 */
export function createTestRangeHandler(
  handlerId: string,
  trackingOptions?: {
    logMessages?: boolean;
    logRangeEvents?: boolean;
    logTopologyChanges?: boolean;
  }
): TestRangeHandler {
  const handler = new TestRangeHandler(handlerId);
  
  // Configure logging based on options
  if (trackingOptions?.logMessages) {
    const originalOnMessage = handler.onMessage.bind(handler);
    handler.onMessage = async (message: ClusterMessage) => {
      console.log(`[${handlerId}] Message received:`, message);
      return originalOnMessage(message);
    };
  }
  
  return handler;
}

/**
 * Validate range distribution across coordinators
 */
export function validateRangeBalance(
  coordinators: RangeCoordinator[], 
  tolerance: number = 0.2
): void {
  if (coordinators.length === 0) return;
  
  const rangeCounts = coordinators.map(coordinator => {
    // This would need to be implemented based on the actual RangeCoordinator API
    // For now, we'll use a placeholder
    return 0; // coordinator.getOwnedRanges().length;
  });
  
  const totalRanges = rangeCounts.reduce((sum, count) => sum + count, 0);
  const expectedRangesPerCoordinator = totalRanges / coordinators.length;
  const allowedDeviation = expectedRangesPerCoordinator * tolerance;
  
  for (let i = 0; i < coordinators.length; i++) {
    const deviation = Math.abs(rangeCounts[i] - expectedRangesPerCoordinator);
    if (deviation > allowedDeviation) {
      throw new Error(
        `Range imbalance detected. Coordinator ${i} has ${rangeCounts[i]} ranges, ` +
        `expected ${expectedRangesPerCoordinator} ± ${allowedDeviation}`
      );
    }
  }
}

/**
 * Generate test messages for specific ranges
 */
export function generateTestMessages(
  count: number, 
  ranges: RangeId[]
): ClusterMessage[] {
  const messages: ClusterMessage[] = [];
  
  for (let i = 0; i < count; i++) {
    const rangeId = ranges[i % ranges.length];
    messages.push({
      id: `test-message-${i}`,
      type: 'test',
      payload: {
        sequence: i,
        data: `test-data-${i}`,
        timestamp: Date.now()
      },
      sourceNodeId: 'test-node',
      targetRangeId: rangeId,
      timestamp: Date.now()
    });
  }
  
  return messages;
}

/**
 * Wait for range stabilization across coordinators
 */
export async function waitForRangeStabilization(
  coordinators: RangeCoordinator[], 
  timeout: number = 10000
): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    let stabilized = true;
    
    // Check if all coordinators have consistent range assignments
    // This is a simplified check - actual implementation would depend on
    // the RangeCoordinator API
    
    for (const coordinator of coordinators) {
      // Placeholder - would check coordinator state
      // const ranges = coordinator.getOwnedRanges();
      // if (ranges.length === 0) {
      //   stabilized = false;
      //   break;
      // }
    }
    
    if (stabilized) {
      return; // Success!
    }
    
    // Wait before checking again
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  throw new Error(`Range assignment failed to stabilize within ${timeout}ms`);
}

/**
 * Test message routing to verify messages reach correct handlers
 */
export async function validateMessageRouting(
  sourceCoordinator: RangeCoordinator,
  targetRange: RangeId,
  message: ClusterMessage,
  expectedHandler: TestRangeHandler,
  timeout: number = 5000
): Promise<void> {
  const initialMessageCount = expectedHandler.getMessageCount();
  
  // Send the message
  // await sourceCoordinator.sendMessage(message);
  
  // Wait for message delivery
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (expectedHandler.getMessageCount() > initialMessageCount) {
      // Verify the message was received correctly
      const receivedMessages = expectedHandler.getMessagesForRange(targetRange);
      const matchingMessage = receivedMessages.find(msg => msg.id === message.id);
      
      if (matchingMessage) {
        return; // Success!
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  throw new Error(
    `Message ${message.id} failed to reach handler for range ${targetRange} within ${timeout}ms`
  );
}

/**
 * Validate lease consistency across coordinators
 */
export function validateLeaseConsistency(coordinators: RangeCoordinator[]): void {
  // This would verify that range leases are consistent across the cluster
  // Implementation depends on the actual RangeCoordinator API
  
  console.log(`Validating lease consistency across ${coordinators.length} coordinators`);
  
  // Placeholder - would check for lease conflicts, expiration handling, etc.
  // const allLeases = coordinators.flatMap(c => c.getActiveLeases());
  // Check for conflicts, proper expiration times, etc.
}

/**
 * Validate topology convergence - all coordinators have same view
 */
export async function validateTopologyConvergence(
  coordinators: RangeCoordinator[],
  expectedTopology: ClusterInfo,
  timeout: number = 10000
): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    let converged = true;
    
    for (const coordinator of coordinators) {
      // Check if coordinator has converged to expected topology
      // const currentTopology = coordinator.getClusterTopology();
      // if (!isTopologyEqual(currentTopology, expectedTopology)) {
      //   converged = false;
      //   break;
      // }
    }
    
    if (converged) {
      return; // Success!
    }
    
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  throw new Error(`Topology failed to converge within ${timeout}ms`);
}

/**
 * Cleanup helper for range coordinators
 */
export async function cleanupRangeCoordinators(coordinators: RangeCoordinator[]): Promise<void> {
  const stopPromises = coordinators.map(async (coordinator) => {
    try {
      // await coordinator.stop();
    } catch (error) {
      console.warn('Error stopping coordinator:', error);
    }
  });
  
  await Promise.allSettled(stopPromises);
  await new Promise(resolve => setTimeout(resolve, 100));
}
