export interface RoutedMessage {
  type: string;
  [key: string]: any;
}

export interface MessageHandler {
  handle(message: RoutedMessage, session: Session): void;
}

// Import Session type from connections
import { Session } from '../connections/Session';
export const IClusterCommunication = undefined; // TODO: Implement IClusterCommunication
export const CommunicationConfig = undefined; // TODO: Implement CommunicationConfig
export const GossipTargetSelection = undefined; // TODO: Implement GossipTargetSelection
