import { MessageHandler, RoutedMessage } from '../../types';
import { Session } from '../../../connections/Session';

export class DiagnosticsHandler implements MessageHandler {
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
    console.log(`Ping from session ${session.id}`);
  }

  private handleStatus(message: RoutedMessage, session: Session): void {
    console.log(`Status request from session ${session.id}`);
  }

  private handleDebug(message: RoutedMessage, session: Session): void {
    console.log(`Debug request from session ${session.id}`);
  }
}
