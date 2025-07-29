import { DiagnosticsHandler } from '../DiagnosticsHandler';
import { RoutedMessage } from '../../../types';
import { Session } from '../../../../connections/Session';

// Mock Session
jest.mock('../../../../connections/Session');

describe('DiagnosticsHandler', () => {
  let diagnosticsHandler: DiagnosticsHandler;
  let mockSession: jest.Mocked<Session>;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    diagnosticsHandler = new DiagnosticsHandler();
    mockSession = {
      id: 'test-session-id'
    } as jest.Mocked<Session>;
    
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  describe('handle', () => {
    it('should handle diagnostics.ping message', () => {
      const message: RoutedMessage = {
        type: 'diagnostics.ping',
        timestamp: 1234567890
      };

      diagnosticsHandler.handle(message, mockSession);

      expect(consoleLogSpy).toHaveBeenCalledWith('Ping from session test-session-id');
    });

    it('should handle diagnostics.status message', () => {
      const message: RoutedMessage = {
        type: 'diagnostics.status'
      };

      diagnosticsHandler.handle(message, mockSession);

      expect(consoleLogSpy).toHaveBeenCalledWith('Status request from session test-session-id');
    });

    it('should handle diagnostics.debug message', () => {
      const message: RoutedMessage = {
        type: 'diagnostics.debug',
        level: 'info'
      };

      diagnosticsHandler.handle(message, mockSession);

      expect(consoleLogSpy).toHaveBeenCalledWith('Debug request from session test-session-id');
    });

    it('should handle unknown diagnostics message types gracefully', () => {
      const message: RoutedMessage = {
        type: 'diagnostics.unknown'
      };

      expect(() => diagnosticsHandler.handle(message, mockSession)).not.toThrow();
    });
  });
});
