import { Router } from '../Router';
import { MessageHandler, RoutedMessage } from '../types';
import { Session } from '../../connections/Session';

// Mock Session
jest.mock('../../connections/Session');

describe('Router', () => {
  let router: Router;
  let mockSession: jest.Mocked<Session>;

  beforeEach(() => {
    router = new Router();
    mockSession = new Session('test-id', {}) as jest.Mocked<Session>;
  });

  describe('register', () => {
    it('should register a handler for a message type', () => {
      const handler: MessageHandler = {
        handle: jest.fn()
      };

      router.register('test-message', handler);

      expect(router.hasHandler('test-message')).toBe(true);
    });

    it('should throw error when registering handler for existing type', () => {
      const handler1: MessageHandler = {
        handle: jest.fn()
      };
      const handler2: MessageHandler = {
        handle: jest.fn()
      };

      router.register('test-message', handler1);
      
      expect(() => router.register('test-message', handler2)).toThrow(
        'Handler already registered for type: test-message'
      );
    });
  });

  describe('route', () => {
    it('should route message to registered handler', () => {
      const mockHandle = jest.fn();
      const handler: MessageHandler = {
        handle: mockHandle
      };
      const message: RoutedMessage = {
        type: 'test-message',
        payload: { data: 'test' }
      };

      router.register('test-message', handler);
      router.route(message, mockSession);

      expect(mockHandle).toHaveBeenCalledWith(message, mockSession);
    });

    it('should throw error for unregistered message type', () => {
      const message: RoutedMessage = {
        type: 'unknown-message',
        payload: { data: 'test' }
      };

      expect(() => router.route(message, mockSession)).toThrow(
        'No handler for message type: unknown-message'
      );
    });

    it('should handle handler errors gracefully', () => {
      const error = new Error('Handler error');
      const mockHandle = jest.fn().mockImplementation(() => {
        throw error;
      });
      const handler: MessageHandler = {
        handle: mockHandle
      };
      const message: RoutedMessage = {
        type: 'test-message',
        payload: { data: 'test' }
      };

      router.register('test-message', handler);

      expect(() => router.route(message, mockSession)).toThrow('Handler error');
    });
  });

  describe('unregister', () => {
    it('should unregister a handler for a message type', () => {
      const handler: MessageHandler = {
        handle: jest.fn()
      };

      router.register('test-message', handler);
      expect(router.hasHandler('test-message')).toBe(true);

      const result = router.unregister('test-message');
      expect(result).toBe(true);
      expect(router.hasHandler('test-message')).toBe(false);
    });

    it('should return false for unregistering non-existent handler', () => {
      const result = router.unregister('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('hasHandler', () => {
    it('should return true for registered handler', () => {
      const handler: MessageHandler = {
        handle: jest.fn()
      };

      router.register('test-message', handler);
      expect(router.hasHandler('test-message')).toBe(true);
    });

    it('should return false for unregistered handler', () => {
      expect(router.hasHandler('non-existent')).toBe(false);
    });
  });

  describe('getRegisteredTypes', () => {
    it('should return all registered handler types', () => {
      const handler1: MessageHandler = {
        handle: jest.fn()
      };
      const handler2: MessageHandler = {
        handle: jest.fn()
      };

      router.register('message-1', handler1);
      router.register('message-2', handler2);

      const handlerTypes = router.getRegisteredTypes();
      expect(handlerTypes).toContain('message-1');
      expect(handlerTypes).toContain('message-2');
      expect(handlerTypes).toHaveLength(2);
    });

    it('should return empty array when no handlers registered', () => {
      expect(router.getRegisteredTypes()).toEqual([]);
    });
  });
});
