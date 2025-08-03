import { EventEmitter } from 'events';
import { NodeId, Message } from '../types';

/**
 * Base transport class for network communication
 */
export abstract class Transport extends EventEmitter {
  constructor() {
    super();
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract send(message: Message, target: NodeId): Promise<void>;

  /**
   * Register a callback to handle incoming messages
   */
  abstract onMessage(callback: (message: Message) => void): void;

  /**
   * Remove a message listener
   */
  abstract removeMessageListener(callback: (message: Message) => void): void;

  /**
   * Get currently connected nodes
   */
  abstract getConnectedNodes(): NodeId[];

  /**
   * Get local node information
   */
  abstract getLocalNodeInfo(): NodeId;
}
