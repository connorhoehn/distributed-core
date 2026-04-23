export { GossipCoordinator } from './GossipCoordinator';
export { GossipStrategy } from './GossipStrategy';
export {
  GossipMessage,
  MessageFactory,
  MessageType,
  MessagePriority
} from './transport/GossipMessage';
export type {
  MessageHeader,
  MessagePayload,
  MessageMetrics
} from './transport/GossipMessage';
export { GossipBackoff } from './transport/GossipBackoff';
