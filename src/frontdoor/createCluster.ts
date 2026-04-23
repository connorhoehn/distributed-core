import { ClusterOptions, NodeOptions } from './types';
import { ClusterHandle } from './ClusterHandle';
import { createNode } from './createNode';
import { createId } from '../common/utils';

/**
 * Create a multi-node cluster with automatic seed wiring.
 *
 * @example
 * ```ts
 * // 3-node in-memory cluster with auto-start
 * const cluster = await createCluster({ size: 3, autoStart: true });
 * await cluster.waitForConvergence();
 * ```
 */
export async function createCluster(options?: Partial<ClusterOptions>): Promise<ClusterHandle> {
  const size = options?.size ?? 3;
  const basePort = options?.basePort ?? 0;
  const transport = options?.transport ?? 'in-memory';
  const autoStart = options?.autoStart ?? false;
  const startupDelay = options?.startupDelay ?? 100;
  const clusterId = options?.clusterId ?? `cluster-${createId()}`;
  const nodeDefaults = options?.nodeDefaults ?? {};
  const nodeOverrides = options?.nodes ?? [];

  // Pre-generate ids and addresses so seed wiring can reference node 0
  const nodeConfigs: Partial<NodeOptions>[] = [];

  for (let i = 0; i < size; i++) {
    const perNode = nodeOverrides[i] ?? {};
    const id = perNode.id ?? nodeDefaults.id ?? createId();
    const address = perNode.address ?? nodeDefaults.address ?? '127.0.0.1';
    const port = perNode.port ?? (basePort > 0 ? basePort + i : 0);

    // Node 0 gets no seed nodes; all others seed to node 0.
    // For in-memory transport, seed by node ID (the InMemoryAdapter registry key).
    // For network transports, seed by address:port.
    let seedNodes: string[];
    if (i === 0) {
      seedNodes = [];
    } else {
      const node0Id = nodeConfigs[0].id!;
      if (transport === 'in-memory') {
        seedNodes = [node0Id];
      } else {
        const node0Address = nodeConfigs[0].address ?? '127.0.0.1';
        const node0Port = nodeConfigs[0].port ?? 0;
        seedNodes = [`${node0Address}:${node0Port}`];
      }
    }

    nodeConfigs.push({
      ...nodeDefaults,
      ...perNode,
      id,
      address,
      port,
      transport,
      seedNodes,
      clusterId,
      // Never auto-start individual nodes; ClusterHandle manages start order
      autoStart: false,
    });
  }

  // Create all nodes
  const handles = await Promise.all(
    nodeConfigs.map(cfg => createNode(cfg)),
  );

  const cluster = new ClusterHandle(handles, startupDelay);

  if (autoStart) {
    await cluster.start();
  }

  return cluster;
}
