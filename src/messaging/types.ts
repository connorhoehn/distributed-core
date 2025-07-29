export interface RoutedMessage {
  type: string;
  [key: string]: any;
}

export interface MessageHandler {
  handle(message: RoutedMessage, session: Session): void;
}

// Import Session type from connections
import { Session } from '../connections/Session';
