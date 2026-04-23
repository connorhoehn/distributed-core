export type PubSubHandler = (topic: string, payload: unknown, metadata: PubSubMessageMetadata) => void;

export interface PubSubMessageMetadata {
  messageId: string;
  publisherNodeId: string;
  timestamp: number;
  topic: string;
}

export interface Subscription {
  id: string;
  topic: string;
  handler: PubSubHandler;
  createdAt: number;
}

export interface PubSubConfig {
  enableCrossNodeDelivery?: boolean;  // default true
  messageDeduplicationTTL?: number;   // ms, default 60000
}

export interface PubSubStats {
  topicCount: number;
  totalSubscriptions: number;
  messagesPublished: number;
  messagesDelivered: number;
  crossNodeMessages: number;
}
