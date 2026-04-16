# Chat Room Example

This example demonstrates how to build a distributed chat room on top of
`distributed-core` using the `RangeHandler` pattern.

## What is ChatRoomCoordinator?

`ChatRoomCoordinator` is an application-level coordinator that manages chat
rooms across a cluster of nodes. It was originally located in
`src/messaging/handlers/` but has been moved here because it contains
**business logic** (chat rooms, participants, messages) that does not belong in
the core library.

Key capabilities:

- **Range-based ownership** -- each chat room is assigned to a hash-ring range;
  the node that owns the range owns the room.
- **Cross-node message routing** -- messages from clients connected to any node
  are forwarded to the room-owner node and then fanned out to all subscribers.
- **WAL persistence** -- room state and messages are persisted through the
  core WAL subsystem so they survive restarts.
- **Envelope-based operations** -- optionally wraps messages in
  `ResourceOperation` envelopes for cluster-wide fanout via
  `ClusterFanoutRouter`.

## Running the example

```bash
npx ts-node examples/chat-room/index.ts
```

The entry point (`index.ts`) creates a single-node cluster with an in-memory
transport and exercises basic room operations (create, join, send message,
leave).
