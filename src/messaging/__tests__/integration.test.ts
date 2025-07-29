import { createRouter } from '../index';
import { Session } from '../../connections/Session';
import { RoutedMessage } from '../types';

describe('Messaging Integration', () => {
  let router: ReturnType<typeof createRouter>;
  let mockSession: Session;

  beforeEach(() => {
    router = createRouter();
    mockSession = new Session('test-session', {});
  });

  it('should handle session messages through router', () => {
    const spy = jest.spyOn(mockSession, 'setTag');
    
    const joinMessage: RoutedMessage = {
      type: 'session.join',
      roomId: 'room-123',
      userId: 'user-456'
    };

    router.route(joinMessage, mockSession);

    expect(spy).toHaveBeenCalledWith('room', 'room-123');
    expect(spy).toHaveBeenCalledWith('user', 'user-456');
  });

  it('should handle auth messages through router', () => {
    const spy = jest.spyOn(mockSession, 'setTag');
    
    const loginMessage: RoutedMessage = {
      type: 'auth.login',
      userId: 'user-123'
    };

    router.route(loginMessage, mockSession);

    expect(spy).toHaveBeenCalledWith('user', 'user-123');
    expect(spy).toHaveBeenCalledWith('authenticated', 'true');
  });

  it('should handle diagnostics messages through router', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    
    const pingMessage: RoutedMessage = {
      type: 'diagnostics.ping',
      timestamp: Date.now()
    };

    router.route(pingMessage, mockSession);

    expect(consoleSpy).toHaveBeenCalledWith('Ping from session test-session');
    
    consoleSpy.mockRestore();
  });

  it('should throw error for unregistered message types', () => {
    const unknownMessage: RoutedMessage = {
      type: 'unknown.message'
    };

    expect(() => router.route(unknownMessage, mockSession)).toThrow(
      'No handler for message type: unknown.message'
    );
  });

  it('should list all registered handler types', () => {
    const types = router.getRegisteredTypes();
    
    expect(types).toContain('session.join');
    expect(types).toContain('session.leave');
    expect(types).toContain('auth.login');
    expect(types).toContain('auth.logout');
    expect(types).toContain('diagnostics.ping');
    expect(types).toContain('diagnostics.status');
    expect(types).toContain('diagnostics.debug');
  });
});
