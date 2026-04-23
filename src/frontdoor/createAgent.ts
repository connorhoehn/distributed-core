import { AgentOptions } from './types';
import { AgentHandle } from './AgentHandle';
import { createNode } from './createNode';
import { createClusterNode } from '../coordinators/RangeCoordinator';
import { ClusterNodeConfig, CoordinatorType } from '../coordinators/types';

/**
 * Create an agent node that participates in range-based cluster coordination.
 *
 * @example
 * ```ts
 * const agent = await createAgent({
 *   rangeHandler: myHandler,
 *   coordinator: 'in-memory',
 *   ringId: 'chat-rooms',
 * });
 * await agent.start();
 * ```
 */
export async function createAgent(options: AgentOptions): Promise<AgentHandle> {
  if (!options.rangeHandler) {
    throw new Error('AgentOptions.rangeHandler is required');
  }

  // Create the underlying node (without autoStart — we manage lifecycle)
  const nodeHandle = await createNode({ ...options, autoStart: false });

  // Build ClusterNodeConfig for the RangeCoordinator
  const clusterNodeConfig: ClusterNodeConfig = {
    nodeId: nodeHandle.id,
    ringId: options.ringId ?? 'default-ring',
    rangeHandler: options.rangeHandler,
    coordinator: (options.coordinator ?? 'in-memory') as CoordinatorType,
    transport: 'in-memory',
    seedNodes: options.seedNodes,
    coordinatorConfig: options.coordinatorConfig,
  };

  const coordinator = createClusterNode(clusterNodeConfig);
  const handle = new AgentHandle(nodeHandle, coordinator);

  if (options.autoStart) {
    await handle.start();
  }

  return handle;
}
