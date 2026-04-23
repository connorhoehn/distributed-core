/**
 * ApiHandler -- registers HTTP-like message handlers on a Node instance.
 *
 * Demonstrates:
 *   - Node class lifecycle
 *   - Router + registerHandler for typed message routing
 *   - StateStore for simple data persistence
 *   - ConnectionManager for connection tracking
 *
 * Because we are in a single-process demo, "responses" are written to a
 * shared map that the caller reads back synchronously.
 */
import { Node, StateStore } from 'distributed-core';
import { routes } from './routes';

/** Shared response map so callers can read handler results. */
export const apiResponses = new Map<string, any>();

/**
 * Register all API route handlers on a Node.
 */
export function registerApiHandlers(node: Node, store: StateStore): void {
  // GET:/health
  node.registerHandler('GET:/health', (message) => {
    const health = node.getClusterHealth();
    apiResponses.set(message.requestId ?? message.type, {
      status: 'ok',
      nodeId: node.id,
      cluster: {
        totalNodes: health.totalNodes,
        aliveNodes: health.aliveNodes,
        suspectNodes: health.suspectNodes,
        deadNodes: health.deadNodes,
        isHealthy: health.isHealthy,
      },
    });
  });

  // GET:/members
  node.registerHandler('GET:/members', (message) => {
    const membership = node.getMembership();
    const members: any[] = [];
    membership.forEach((entry: any, id: string) => {
      members.push({ id, status: entry.status ?? 'unknown' });
    });
    apiResponses.set(message.requestId ?? message.type, {
      nodeId: node.id,
      members,
      count: members.length,
    });
  });

  // POST:/data
  node.registerHandler('POST:/data', (message) => {
    const { key, value } = message.payload ?? message;
    if (!key) {
      apiResponses.set(message.requestId ?? message.type, {
        error: 'missing key',
      });
      return;
    }
    store.set(key, value);
    apiResponses.set(message.requestId ?? message.type, {
      ok: true,
      key,
    });
  });

  // GET:/data
  node.registerHandler('GET:/data', (message) => {
    const key = message.key ?? message.payload?.key;
    const value = store.get(key);
    apiResponses.set(message.requestId ?? message.type, {
      key,
      value: value ?? null,
    });
  });

  // GET:/info
  node.registerHandler('GET:/info', (message) => {
    const info = node.getNodeInfo();
    const topology = node.getClusterTopology();
    apiResponses.set(message.requestId ?? message.type, {
      nodeId: node.id,
      info,
      topology: {
        totalAliveNodes: topology.totalAliveNodes,
        zones: topology.zones,
        regions: topology.regions,
      },
    });
  });
}

/**
 * Helper to send a message to a node and return the handler's response.
 */
export function sendApiRequest(
  node: Node,
  messageType: string,
  payload: Record<string, any> = {}
): any {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  node.routeMessage({ type: messageType, requestId, payload, ...payload });
  return apiResponses.get(requestId);
}
