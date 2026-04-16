import { MessageHandler, RoutedMessage } from '../../types';
import { Session } from '../../../connections/Session';
import { Logger } from '../../../common/logger';

export class DiagnosticsHandler implements MessageHandler {
  private logger = Logger.create('DiagnosticsHandler');

  handle(message: RoutedMessage, session: Session): void {
    switch (message.type) {
      case 'diagnostics.ping':
        this.handlePing(message, session);
        break;
      case 'diagnostics.status':
        this.handleStatus(message, session);
        break;
      case 'diagnostics.debug':
        this.handleDebug(message, session);
        break;
      default:
        // Silently ignore unknown message types
        break;
    }
  }

  private handlePing(message: RoutedMessage, session: Session): void {
    this.logger.info(`Ping from session ${session.id}`);
  }

  private handleStatus(message: RoutedMessage, session: Session): void {
    this.logger.info(`Status request from session ${session.id}`);
  }

  private handleDebug(message: RoutedMessage, session: Session): void {
    this.logger.debug(`Debug request from session ${session.id}`);
  }
}
