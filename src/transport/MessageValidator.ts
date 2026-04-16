import { Message, MessageType } from '../types';
import { Transport } from './Transport';
import { NodeId } from '../types';
import { Logger } from '../common/logger';

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Options for the validated transport wrapper
// ---------------------------------------------------------------------------

export interface ValidatedTransportOptions {
  /** Maximum allowed message size in bytes (default 1 MB). */
  maxMessageSizeBytes?: number;
  /** Require `id` field (default true). */
  requireId?: boolean;
  /** Require `type` field (default true). */
  requireType?: boolean;
  /** Require `sender` field (default true). */
  requireSender?: boolean;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

const VALID_MESSAGE_TYPES = new Set<string>(Object.values(MessageType));

const DEFAULT_MAX_BYTES = 1_048_576; // 1 MB

export class MessageValidator {
  /**
   * Validate that `message` has the required fields and correct types to be a
   * well-formed {@link Message}.
   */
  static validate(message: unknown): ValidationResult {
    const errors: string[] = [];

    if (message === null || message === undefined || typeof message !== 'object') {
      return { valid: false, errors: ['Message must be a non-null object'] };
    }

    const msg = message as Record<string, unknown>;

    // id -------------------------------------------------------------------
    if (msg.id === undefined) {
      errors.push('Missing required field: id');
    } else if (typeof msg.id !== 'string') {
      errors.push('Field "id" must be a string');
    }

    // type -----------------------------------------------------------------
    if (msg.type === undefined) {
      errors.push('Missing required field: type');
    } else if (typeof msg.type !== 'string' || !VALID_MESSAGE_TYPES.has(msg.type)) {
      errors.push(
        `Field "type" must be a valid MessageType (got "${String(msg.type)}")`,
      );
    }

    // sender ---------------------------------------------------------------
    if (msg.sender === undefined) {
      errors.push('Missing required field: sender');
    } else if (typeof msg.sender !== 'object' || msg.sender === null) {
      errors.push('Field "sender" must be an object');
    } else {
      const sender = msg.sender as Record<string, unknown>;
      if (typeof sender.id !== 'string') {
        errors.push('Field "sender.id" must be a string');
      }
    }

    // timestamp ------------------------------------------------------------
    if (msg.timestamp === undefined) {
      errors.push('Missing required field: timestamp');
    } else if (typeof msg.timestamp !== 'number') {
      errors.push('Field "timestamp" must be a number');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validate that the JSON-serialised form of `message` does not exceed
   * `maxBytes` (default 1 MB).
   */
  static validateSize(
    message: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    maxBytes: number = DEFAULT_MAX_BYTES,
  ): ValidationResult {
    const json = JSON.stringify(message);
    const byteLength = Buffer.byteLength(json, 'utf8');

    if (byteLength > maxBytes) {
      return {
        valid: false,
        errors: [
          `Message size (${byteLength} bytes) exceeds limit (${maxBytes} bytes)`,
        ],
      };
    }

    return { valid: true, errors: [] };
  }

  /**
   * Return a {@link Transport} wrapper that validates every outgoing and
   * incoming message. Invalid messages are silently dropped after emitting a
   * `console.warn`.
   */
  static wrapTransport(
    transport: Transport,
    options: ValidatedTransportOptions = {},
  ): Transport {
    return new ValidatedTransport(transport, options);
  }
}

// ---------------------------------------------------------------------------
// Validated transport proxy
// ---------------------------------------------------------------------------

class ValidatedTransport extends Transport {
  private readonly inner: Transport;
  private readonly logger = Logger.create('MessageValidator');
  private readonly maxMessageSizeBytes: number;
  private readonly requireId: boolean;
  private readonly requireType: boolean;
  private readonly requireSender: boolean;

  constructor(inner: Transport, options: ValidatedTransportOptions = {}) {
    super();
    this.inner = inner;
    this.maxMessageSizeBytes =
      options.maxMessageSizeBytes ?? DEFAULT_MAX_BYTES;
    this.requireId = options.requireId ?? true;
    this.requireType = options.requireType ?? true;
    this.requireSender = options.requireSender ?? true;
  }

  // -- delegated lifecycle -------------------------------------------------

  start(): Promise<void> {
    return this.inner.start();
  }

  stop(): Promise<void> {
    return this.inner.stop();
  }

  getConnectedNodes(): NodeId[] {
    return this.inner.getConnectedNodes();
  }

  getLocalNodeInfo(): NodeId {
    return this.inner.getLocalNodeInfo();
  }

  // -- validated send ------------------------------------------------------

  async send(message: Message, target: NodeId): Promise<void> {
    const result = this.validateMessage(message);
    if (!result.valid) {
      this.logger.warn(
        `[MessageValidator] Dropping outgoing message: ${result.errors.join('; ')}`,
      );
      return;
    }
    return this.inner.send(message, target);
  }

  // -- validated receive ---------------------------------------------------

  onMessage(callback: (message: Message) => void): void {
    const wrappedCallback = (message: Message): void => {
      const result = this.validateMessage(message);
      if (!result.valid) {
        this.logger.warn(
          `[MessageValidator] Dropping incoming message: ${result.errors.join('; ')}`,
        );
        return;
      }
      callback(message);
    };

    // Store the mapping so removeMessageListener can work.
    (callback as any).__validatedWrapper = wrappedCallback; // eslint-disable-line @typescript-eslint/no-explicit-any
    this.inner.onMessage(wrappedCallback);
  }

  removeMessageListener(callback: (message: Message) => void): void {
    const wrapper =
      (callback as any).__validatedWrapper ?? callback; // eslint-disable-line @typescript-eslint/no-explicit-any
    this.inner.removeMessageListener(wrapper);
  }

  // -- private helpers -----------------------------------------------------

  private validateMessage(message: unknown): ValidationResult {
    const structResult = MessageValidator.validate(message);
    const errors = [...structResult.errors];

    // Respect per-field opt-outs
    if (!this.requireId) {
      const idx = errors.findIndex((e) => e.includes('id'));
      if (idx !== -1 && errors[idx].startsWith('Missing required field: id')) {
        errors.splice(idx, 1);
      }
    }
    if (!this.requireType) {
      const idx = errors.findIndex((e) => e.startsWith('Missing required field: type'));
      if (idx !== -1) errors.splice(idx, 1);
    }
    if (!this.requireSender) {
      const idx = errors.findIndex((e) => e.startsWith('Missing required field: sender'));
      if (idx !== -1) errors.splice(idx, 1);
    }

    // Size check
    const sizeResult = MessageValidator.validateSize(
      message,
      this.maxMessageSizeBytes,
    );
    if (!sizeResult.valid) {
      errors.push(...sizeResult.errors);
    }

    return { valid: errors.length === 0, errors };
  }
}
