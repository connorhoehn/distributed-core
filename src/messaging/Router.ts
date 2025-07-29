import { RoutedMessage, MessageHandler } from './types';
import { Session } from '../connections/Session';

export class Router {
  private handlers = new Map<string, MessageHandler>();

  register(type: string, handler: MessageHandler): void {
    if (this.handlers.has(type)) {
      throw new Error(`Handler already registered for type: ${type}`);
    }
    this.handlers.set(type, handler);
  }

  route(message: RoutedMessage, session: Session): void {
    const handler = this.handlers.get(message.type);
    if (!handler) {
      throw new Error(`No handler for message type: ${message.type}`);
    }
    handler.handle(message, session);
  }

  unregister(type: string): boolean {
    return this.handlers.delete(type);
  }

  getRegisteredTypes(): string[] {
    return Array.from(this.handlers.keys());
  }

  hasHandler(type: string): boolean {
    return this.handlers.has(type);
  }
}
