import { SessionHandler } from '../SessionHandler';
import { RoutedMessage } from '../../../types';
import { Session } from '../../../../connections/Session';

// Mock Session
jest.mock('../../../../connections/Session');

describe('SessionHandler', () => {
  let sessionHandler: SessionHandler;
  let mockSession: jest.Mocked<Session>;

  beforeEach(() => {
    sessionHandler = new SessionHandler();
    mockSession = new Session('test-id', {}) as jest.Mocked<Session>;
    mockSession.setTag = jest.fn();
    mockSession.getTag = jest.fn();
    mockSession.removeTag = jest.fn();
  });

  describe('handle', () => {
    it('should handle session.join message', () => {
      const message: RoutedMessage = {
        type: 'session.join',
        roomId: 'room-123',
        userId: 'user-456'
      };

      sessionHandler.handle(message, mockSession);

      expect(mockSession.setTag).toHaveBeenCalledWith('room', 'room-123');
      expect(mockSession.setTag).toHaveBeenCalledWith('user', 'user-456');
    });

    it('should handle session.leave message', () => {
      const message: RoutedMessage = {
        type: 'session.leave',
        roomId: 'room-123'
      };

      sessionHandler.handle(message, mockSession);

      expect(mockSession.removeTag).toHaveBeenCalledWith('room');
    });

    it('should handle session.join without userId', () => {
      const message: RoutedMessage = {
        type: 'session.join',
        roomId: 'room-123'
      };

      sessionHandler.handle(message, mockSession);

      expect(mockSession.setTag).toHaveBeenCalledWith('room', 'room-123');
      expect(mockSession.setTag).not.toHaveBeenCalledWith('user', expect.anything());
    });

    it('should handle session.join without roomId', () => {
      const message: RoutedMessage = {
        type: 'session.join',
        userId: 'user-456'
      };

      sessionHandler.handle(message, mockSession);

      expect(mockSession.setTag).toHaveBeenCalledWith('user', 'user-456');
      expect(mockSession.setTag).not.toHaveBeenCalledWith('room', expect.anything());
    });

    it('should handle unknown session message types gracefully', () => {
      const message: RoutedMessage = {
        type: 'session.unknown'
      };

      expect(() => sessionHandler.handle(message, mockSession)).not.toThrow();
    });
  });
});
