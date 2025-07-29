import { Router } from '../../Router';
import { DiagnosticsHandler } from './DiagnosticsHandler';

export function registerDiagnosticsHandlers(router: Router): void {
  const handler = new DiagnosticsHandler();
  
  // Register all diagnostics-related message types
  router.register('diagnostics.ping', handler);
  router.register('diagnostics.status', handler);
  router.register('diagnostics.debug', handler);
}

// Export specific message types for this handler
export const DIAGNOSTICS_MESSAGE_TYPES = ['diagnostics.ping', 'diagnostics.status', 'diagnostics.debug'] as const;
export type DiagnosticsMessageType = typeof DIAGNOSTICS_MESSAGE_TYPES[number];
