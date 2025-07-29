import { AuthHandler } from '../AuthHandler';
import { RoutedMessage } from '../../../types';
import { Session } from '../../../../connections/Session';

// Mock Session
jest.mock('../../../../connections/Session');

describe('AuthHandler', () => {
  let authHandler: AuthHandler;
  let mockSession: jest.Mocked<Session>;

  beforeEach(() => {
    authHandler = new AuthHandler();
    mockSession = new Session('test-id', {}) as jest.Mocked<Session>;
    mockSession.setTag = jest.fn();
    mockSession.getTag = jest.fn().mockReturnValue(null);
    mockSession.removeTag = jest.fn();
  });

  describe('handle', () => {
    it('should handle auth.login message', () => {
      const message: RoutedMessage = {
        type: 'auth.login',
        userId: 'user-123',
        token: 'auth-token-456'
      };

      authHandler.handle(message, mockSession);

      expect(mockSession.setTag).toHaveBeenCalledWith('user', 'user-123');
      expect(mockSession.setTag).toHaveBeenCalledWith('authenticated', 'true');
    });

    it('should handle auth.logout message', () => {
      const message: RoutedMessage = {
        type: 'auth.logout'
      };

      authHandler.handle(message, mockSession);

      expect(mockSession.removeTag).toHaveBeenCalledWith('user');
      expect(mockSession.setTag).toHaveBeenCalledWith('authenticated', 'false');
    });

    it('should handle auth.login without userId', () => {
      const message: RoutedMessage = {
        type: 'auth.login',
        token: 'auth-token-456'
      };

      authHandler.handle(message, mockSession);

      expect(mockSession.setTag).toHaveBeenCalledWith('authenticated', 'true');
      expect(mockSession.setTag).not.toHaveBeenCalledWith('user', expect.anything());
    });

    it('should handle unknown auth message types gracefully', () => {
      const message: RoutedMessage = {
        type: 'auth.unknown'
      };

      expect(() => authHandler.handle(message, mockSession)).not.toThrow();
    });
  });
});
