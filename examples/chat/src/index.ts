// Chat Application Example - built on distributed-core

// Chat Application Module
export {
  ChatApplicationModule,
  ChatRoomResource,
  ChatApplicationConfig,
  ChatApplicationMetrics
} from './ChatApplicationModule';

// Chat Room Coordinator
export {
  ChatRoomCoordinator,
  ChatMessageEntity,
  RoomSubscription
} from './ChatRoomCoordinator';

// Chat Topology Manager
export {
  ChatTopologyManager,
  RoomMetadata,
  ChatNodeCapacity,
  ChatClusterTopology,
  ChatScalingAction,
  RoomScalingCriteria
} from './ChatTopologyManager';
