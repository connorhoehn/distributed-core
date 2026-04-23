import { NodeOptions } from './types';
import { NodeHandle } from './NodeHandle';
import { DEFAULT_NODE_OPTIONS, createTransport } from './defaults';
import { Node, NodeConfig } from '../common/Node';
import { Transport } from '../transport/Transport';
import { createId } from '../common/utils';

/**
 * Create a single distributed node with sensible defaults.
 *
 * @example
 * ```ts
 * // Zero-config — boots an in-memory node
 * const handle = await createNode();
 *
 * // Custom transport
 * const handle = await createNode({ transport: 'websocket', port: 8080 });
 *
 * // Auto-start
 * const handle = await createNode({ autoStart: true });
 * ```
 */
export async function createNode(options?: Partial<NodeOptions>): Promise<NodeHandle> {
  const opts = { ...DEFAULT_NODE_OPTIONS, ...options };

  // Generate id if not provided
  const id = opts.id ?? createId();

  // Resolve transport: pass through Transport instances, otherwise construct from string
  let transport: Transport;
  if (typeof opts.transport === 'string') {
    transport = createTransport(opts.transport, id, {
      address: opts.address,
      port: opts.port,
    });
  } else if (opts.transport instanceof Transport) {
    transport = opts.transport;
  } else {
    // Fallback for any unexpected value — default to in-memory
    transport = createTransport('in-memory', id, {
      address: opts.address,
      port: opts.port,
    });
  }

  // Build NodeConfig for the existing Node constructor
  const nodeConfig: NodeConfig = {
    id,
    clusterId: opts.clusterId,
    region: opts.region,
    zone: opts.zone,
    role: opts.role,
    tags: opts.tags,
    seedNodes: opts.seedNodes,
    transport,
    enableMetrics: opts.metrics,
    enableChaos: opts.chaos,
    enableLogging: opts.logging,
  };

  const node = new Node(nodeConfig);
  const handle = new NodeHandle(node);

  if (opts.autoStart) {
    await handle.start();
  }

  return handle;
}
