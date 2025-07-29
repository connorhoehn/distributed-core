// Core messaging system exports
export { Router } from './Router';
export type { RoutedMessage, MessageHandler } from './types';

// Handler registration functions
export { registerSessionHandlers } from './handlers/session/registerHandlers';
export { registerAuthHandlers } from './handlers/auth/registerHandlers';
export { registerDiagnosticsHandlers } from './handlers/diagnostics/registerHandlers';

// Message type exports for type safety
export type { SessionMessageType } from './handlers/session/registerHandlers';
export type { AuthMessageType } from './handlers/auth/registerHandlers';
export type { DiagnosticsMessageType } from './handlers/diagnostics/registerHandlers';

// Import what we need for the convenience function
import { Router } from './Router';
import { registerSessionHandlers } from './handlers/session/registerHandlers';
import { registerAuthHandlers } from './handlers/auth/registerHandlers';
import { registerDiagnosticsHandlers } from './handlers/diagnostics/registerHandlers';

// Convenience function to create a fully configured router
export function createRouter(): Router {
  const router = new Router();
  
  // Register all handler modules
  registerSessionHandlers(router);
  registerAuthHandlers(router);
  registerDiagnosticsHandlers(router);
  
  return router;
}
