import { NodeOptions } from './types';
import { Transport } from '../transport/Transport';
import { InMemoryAdapter } from '../transport/adapters/InMemoryAdapter';
import { WebSocketAdapter } from '../transport/adapters/WebSocketAdapter';
import { TCPAdapter } from '../transport/adapters/TCPAdapter';
import { UDPAdapter } from '../transport/adapters/UDPAdapter';
import { HTTPAdapter } from '../transport/adapters/HTTPAdapter';
import { BootstrapConfig } from '../config/BootstrapConfig';
import { NodeId } from '../types';

/**
 * Frozen object containing all default values for NodeOptions.
 */
export const DEFAULT_NODE_OPTIONS: Readonly<Required<Pick<NodeOptions,
  'address' | 'port' | 'transport' | 'seedNodes' | 'clusterId' |
  'persistence' | 'metrics' | 'diagnostics' | 'chaos' | 'logging' | 'autoStart'
>>> = Object.freeze({
  address: '127.0.0.1',
  port: 0,
  transport: 'in-memory' as const,
  seedNodes: [] as string[],
  clusterId: 'default-cluster',
  persistence: 'memory' as const,
  metrics: true,
  diagnostics: false,
  chaos: false,
  logging: false,
  autoStart: false,
});

/**
 * Create a Transport instance from a string type identifier.
 */
export function createTransport(
  type: string,
  nodeId: string,
  options?: { address?: string; port?: number }
): Transport {
  const address = options?.address ?? DEFAULT_NODE_OPTIONS.address;
  const port = options?.port ?? DEFAULT_NODE_OPTIONS.port;

  const nodeIdObj: NodeId = { id: nodeId, address, port };

  switch (type) {
    case 'in-memory':
      return new InMemoryAdapter(nodeIdObj);
    case 'websocket':
      return new WebSocketAdapter(nodeIdObj, { host: address, port });
    case 'tcp':
      return new TCPAdapter(nodeIdObj, { host: address, port });
    case 'udp':
      return new UDPAdapter(nodeIdObj, { host: address, port });
    case 'http':
      return new HTTPAdapter(nodeIdObj, { host: address, port });
    default:
      throw new Error(`Unknown transport type: ${type}`);
  }
}

/**
 * Build a BootstrapConfig from flat NodeOptions.
 */
export function resolveBootstrapConfig(opts: {
  seedNodes?: string[];
  joinTimeout?: number;
  gossipInterval?: number;
  logging?: boolean;
}): BootstrapConfig {
  return new BootstrapConfig(
    opts.seedNodes ?? [],
    opts.joinTimeout ?? 5000,
    opts.gossipInterval ?? 1000,
    opts.logging ?? false,
  );
}
