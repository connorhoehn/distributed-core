import { Router } from '../../Router';
import { SessionHandler } from './SessionHandler';

export function registerSessionHandlers(router: Router): void {
  const handler = new SessionHandler();
  
  // Register all session-related message types
  router.register('session.join', handler);
  router.register('session.leave', handler);
}

// Export specific message types for this handler
export const SESSION_MESSAGE_TYPES = ['session.join', 'session.leave'] as const;
export type SessionMessageType = typeof SESSION_MESSAGE_TYPES[number];
