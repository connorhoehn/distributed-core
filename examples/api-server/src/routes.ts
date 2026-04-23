/**
 * Route definitions for the API server example.
 *
 * Each route maps an HTTP-like verb + path to a handler name used by
 * the Node's Router.  These are simple strings that get registered as
 * message types.
 */

export interface RouteDefinition {
  /** Message type registered with the router. */
  messageType: string;
  /** Human-readable description. */
  description: string;
}

export const routes: RouteDefinition[] = [
  {
    messageType: 'GET:/health',
    description: 'Return cluster health status',
  },
  {
    messageType: 'GET:/members',
    description: 'List current cluster members',
  },
  {
    messageType: 'POST:/data',
    description: 'Store data via the persistence layer',
  },
  {
    messageType: 'GET:/data',
    description: 'Retrieve stored data by key',
  },
  {
    messageType: 'GET:/info',
    description: 'Return node and cluster information',
  },
];
