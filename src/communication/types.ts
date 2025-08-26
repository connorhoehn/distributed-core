export interface CommunicationMessage {
  id: string;
  type: string;
  payload: any;
  metadata: Record<string, any>;
}

export interface DeliveryOptions {
  reliable?: boolean;
  ordered?: boolean;
  timeout?: number;
  retries?: number;
}
