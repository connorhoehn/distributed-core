import { Session } from '../connections/Session';

export interface RoutedMessage {
  type: string;
  [key: string]: unknown;
}

export interface MessageHandler {
  handle(message: RoutedMessage, session: Session): void;
}
