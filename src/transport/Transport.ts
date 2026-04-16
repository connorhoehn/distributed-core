import { EventEmitter } from 'events';
import { NodeId, Message } from '../types';

/**
 * Abstract base for all network transports used by the distributed runtime.
 *
 * Concrete implementations (e.g. WebSocketAdapter, TCPAdapter, InMemoryAdapter)
 * must provide the full send/receive lifecycle. The transport is responsible for
 * serialisation, connection management, and delivery of {@link Message} objects
 * between nodes identified by {@link NodeId}.
 *
 * Transport extends EventEmitter so implementations can emit low-level network
 * events (e.g. `error`, `disconnect`) in addition to the message callback API.
 */
export abstract class Transport extends EventEmitter {
  constructor() {
    super();
  }

  /** Open the transport and begin accepting connections. */
  abstract start(): Promise<void>;

  /** Close the transport and release all network resources. */
  abstract stop(): Promise<void>;

  /** Deliver a message to a specific remote node. */
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