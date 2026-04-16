import { MessageHandler, RoutedMessage } from '../../types';
import { Session } from '../../../connections/Session';

export class AuthHandler implements MessageHandler {
  handle(message: RoutedMessage, session: Session): void {
    switch (message.type) {
      case 'auth.login':
        this.handleLogin(message, session);
        break;
      case 'auth.logout':
        this.handleLogout(message, session);
        break;
      default:
        // Silently ignore unknown message types
        break;
    }
  }

  private handleLogin(message: RoutedMessage, session: Session): void {
    // Assuming userId is in message.payload
    const payload = message['payload'] as Record<string, unknown> | undefined;
    const userId = (message['userId'] as string | undefined) ?? (payload && (payload.userId as string | undefined));
    
    if (userId) {
      session.setTag('user', userId);
    }
    
    session.setTag('authenticated', 'true');
  }

  private handleLogout(message: RoutedMessage, session: Session): void {
    session.removeTag('user');
    session.setTag('authenticated', 'false');
  }
}
