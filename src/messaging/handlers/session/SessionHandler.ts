import { MessageHandler, RoutedMessage } from '../../types';
import { Session } from '../../../connections/Session';

export class SessionHandler implements MessageHandler {
  handle(message: RoutedMessage, session: Session): void {
    switch (message.type) {
      case 'session.join':
        this.handleJoin(message, session);
        break;
      case 'session.leave':
        this.handleLeave(message, session);
        break;
      default:
        // Silently ignore unknown message types
        break;
    }
  }

  private handleJoin(message: RoutedMessage, session: Session): void {
    const { roomId, userId } = message;
    
    if (roomId) {
      session.setTag('room', roomId);
    }
    
    if (userId) {
      session.setTag('user', userId);
    }
  }

  private handleLeave(message: RoutedMessage, session: Session): void {
    const { roomId } = message;
    
    if (roomId) {
      session.removeTag('room');
    }
  }
}
