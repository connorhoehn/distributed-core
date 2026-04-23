// Front Door API — ergonomic entrypoints for distributed-core

// Factory functions
export { createNode } from './createNode';
export { createCluster } from './createCluster';
export { createAgent } from './createAgent';

// Handle classes
export { NodeHandle } from './NodeHandle';
export { ClusterHandle } from './ClusterHandle';
export { AgentHandle } from './AgentHandle';

// Types
export type { NodeOptions, ClusterOptions, AgentOptions } from './types';

// Defaults (for advanced users who want to customize)
export { DEFAULT_NODE_OPTIONS, createTransport, resolveBootstrapConfig } from './defaults';
