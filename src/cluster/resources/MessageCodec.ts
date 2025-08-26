/**
 * Message codec for cluster communication
 * Handles encoding/decoding of operation envelopes for transport
 */

import { ResourceOperation } from './ResourceOperation';

// Node.js environment declarations
declare const Buffer: any;

export interface MessageCodec {
  encode(operation: ResourceOperation): Uint8Array;
  decode(bytes: Uint8Array): ResourceOperation;
}

/**
 * JSON-based codec implementation
 * Pluggable design allows for future binary formats
 */
export class JSONMessageCodec implements MessageCodec {
  encode(operation: ResourceOperation): Uint8Array {
    const jsonString = JSON.stringify(operation);
    return Buffer.from(jsonString, 'utf8');
  }

  decode(bytes: Uint8Array): ResourceOperation {
    const jsonString = Buffer.from(bytes).toString('utf8');
    return JSON.parse(jsonString);
  }
}

/**
 * Default codec instance
 */
export const defaultCodec = new JSONMessageCodec();
