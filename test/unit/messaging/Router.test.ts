import { Router } from '../../../src/messaging/Router';
import { RoutedMessage, MessageHandler } from '../../../src/messaging/types';
import { Session } from '../../../src/connections/Session';

/** Creates a stub handler that records calls for assertions. */
function createMockHandler(): MessageHandler & { calls: Array<{ message: RoutedMessage; session: Session }> } {
  const calls: Array<{ message: RoutedMessage; session: Session }> = [];
  return {
    calls,
    handle(message: RoutedMessage, session: Session): void {
      calls.push({ message, session });
    },
  };
}

describe('Router', () => {
  let router: Router;
  let session: Session;

  beforeEach(() => {
    router = new Router();
    session = new Session('test-session-1');
  });

  describe('register', () => {
    test('should register a handler for a message type', () => {
      const handler = createMockHandler();
      router.register('chat.message', handler);

      expect(router.hasHandler('chat.message')).toBe(true);
      expect(router.getRegisteredTypes()).toContain('chat.message');
    });

    test('should throw when registering a duplicate type', () => {
      const handler = createMockHandler();
      router.register('chat.message', handler);

      expect(() => router.register('chat.message', createMockHandler())).toThrow(
        'Handler already registered for type: chat.message'
      );
    });
  });

  describe('route', () => {
    test('should dispatch to the correct handler', () => {
      const handler = createMockHandler();
      router.register('chat.message', handler);

      const message: RoutedMessage = { type: 'chat.message', payload: 'hello' };
      router.route(message, session);

      expect(handler.calls).toHaveLength(1);
    });

    test('should throw for unknown message types', () => {
      expect(() =>
        router.route({ type: 'nonexistent.type' }, session)
      ).toThrow('No handler for message type: nonexistent.type');
    });

    test('should dispatch to different handlers for different types', () => {
      const chatHandler = createMockHandler();
      const authHandler = createMockHandler();

      router.register('chat.message', chatHandler);
      router.register('auth.login', authHandler);

      router.route({ type: 'chat.message' }, session);
      router.route({ type: 'auth.login' }, session);

      expect(chatHandler.calls).toHaveLength(1);
      expect(authHandler.calls).toHaveLength(1);
    });

    test('should pass the correct message and session to the handler', () => {
      const handler = createMockHandler();
      router.register('chat.message', handler);

      const message: RoutedMessage = { type: 'chat.message', payload: { text: 'hi' }, from: 'user-1' };
      router.route(message, session);

      expect(handler.calls).toHaveLength(1);
      expect(handler.calls[0].message).toBe(message);
      expect(handler.calls[0].message.type).toBe('chat.message');
      expect(handler.calls[0].message.payload).toEqual({ text: 'hi' });
      expect(handler.calls[0].session).toBe(session);
      expect(handler.calls[0].session.id).toBe('test-session-1');
    });
  });

  describe('unregister', () => {
    test('should remove a previously registered handler', () => {
      router.register('chat.message', createMockHandler());
      expect(router.hasHandler('chat.message')).toBe(true);

      const removed = router.unregister('chat.message');
      expect(removed).toBe(true);
      expect(router.hasHandler('chat.message')).toBe(false);
    });

    test('should return false when unregistering a type that was never registered', () => {
      expect(router.unregister('nonexistent')).toBe(false);
    });
  });

  describe('getRegisteredTypes', () => {
    test('should return all registered type strings', () => {
      router.register('chat.message', createMockHandler());
      router.register('auth.login', createMockHandler());
      router.register('session.ping', createMockHandler());

      const types = router.getRegisteredTypes();
      expect(types).toHaveLength(3);
      expect(types).toEqual(expect.arrayContaining(['chat.message', 'auth.login', 'session.ping']));
    });

    test('should return an empty array when no handlers are registered', () => {
      expect(router.getRegisteredTypes()).toEqual([]);
    });
  });
});
