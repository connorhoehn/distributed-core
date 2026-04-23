/**
 * Shared helpers for creating example clusters using the distributed-core
 * RangeCoordinator (the framework's primary coordination primitive).
 */
import {
  createClusterNode,
  ClusterNodeConfig,
  RangeHandler,
  RangeCoordinator,
} from 'distributed-core';

export interface ExampleClusterOptions {
  ringId?: string;
  nodeCount?: number;
  nodeIdPrefix?: string;
  rangeHandlerFactory: () => RangeHandler;
}

/**
 * Create a set of RangeCoordinator nodes configured for in-memory
 * single-process operation with test-friendly short timers.
 */
export async function createExampleCluster(
  options: ExampleClusterOptions
): Promise<RangeCoordinator[]> {
  const {
    ringId = 'example-ring',
    nodeCount = 3,
    nodeIdPrefix = 'node',
    rangeHandlerFactory,
  } = options;

  const nodes: RangeCoordinator[] = [];

  for (let i = 0; i < nodeCount; i++) {
    const config: ClusterNodeConfig = {
      ringId,
      rangeHandler: rangeHandlerFactory(),
      coordinator: 'in-memory',
      transport: 'in-memory',
      nodeId: `${nodeIdPrefix}-${i}`,
      coordinatorConfig: {
        testMode: true,
        heartbeatIntervalMs: 200,
        leaseRenewalIntervalMs: 400,
        leaseTimeoutMs: 2000,
      },
      logging: {
        enableFrameworkLogs: false,
        enableCoordinatorLogs: false,
      },
    };

    const node = createClusterNode(config);
    await node.start();
    nodes.push(node);
  }

  // Give the nodes a moment to acquire ranges
  await sleep(500);

  return nodes;
}

/**
 * Gracefully stop all nodes in a cluster.
 */
export async function shutdownCluster(nodes: RangeCoordinator[]): Promise<void> {
  await Promise.all(nodes.map((n) => n.stop()));
}

/**
 * Utility sleep for demo pacing.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
