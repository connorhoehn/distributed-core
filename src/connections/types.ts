export interface SessionMetadata {
  [key: string]: any;
}

export interface ConnectionTags {
  [key: string]: string | string[];
}

export interface ConnectionConfig {
  heartbeatInterval?: number;
  timeoutMs?: number;
  maxMessageSize?: number;
}

export interface MessageRouterFunction {
  (message: any, connectionId: string): void;
}

export interface SendFunction {
  (data: string | Buffer): void;
}

export type ConnectionStatus = 'active' | 'idle' | 'closed' | 'error';

export interface ConnectionStats {
  messagesSent: number;
  messagesReceived: number;
  bytesTransferred: number;
  lastActivity: number;
  errors: number;
}
