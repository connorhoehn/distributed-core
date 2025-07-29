import { Router } from '../../Router';
import { AuthHandler } from './AuthHandler';

export function registerAuthHandlers(router: Router): void {
  const handler = new AuthHandler();
  
  // Register all auth-related message types
  router.register('auth.login', handler);
  router.register('auth.logout', handler);
}

// Export specific message types for this handler
export const AUTH_MESSAGE_TYPES = ['auth.login', 'auth.logout'] as const;
export type AuthMessageType = typeof AUTH_MESSAGE_TYPES[number];
