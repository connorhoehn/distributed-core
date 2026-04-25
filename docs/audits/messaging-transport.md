# Audit: Messaging, Transport, Backpressure

Date: 2026-04-23
Scope: `src/messaging/`, `src/gateway/pubsub/`, `src/gateway/backpressure/`, `src/gateway/coalescing/`, `src/gateway/eviction/`, `src/transport/`, `src/common/RateLimiter.ts`

---

## Executive Summary

The gateway layer (`backpressure/`, `coalescing/`, `eviction/`) is tight, modern, and follows `LifecycleAware` patterns well. `EventBus` and `PubSubManager` are production-quality with one significant durability gap. The transport layer (`src/transport/`) is clearly older pre-session code: it does not use `LifecycleAware` or `CoreError`, logging goes directly to `console.*`, type safety is `as any` throughout, and several structural issues create real runtime risk. The most severe findings are in transport.

High: 7 · Medium: 10 · Low: 9

---

## High-Severity Findings

### H-1 — EventBus WAL flush window: data loss on crash (Durability)
**File:** `src/messaging/EventBus.ts:205–218`
`publish()` appends to the WAL synchronously but the underlying `WALWriterImpl` only flushes to disk on its `syncInterval` (default 1 000 ms). If the process crashes between `append()` returning and the next sync, the event is lost — it was already delivered to PubSub subscribers but is absent from the WAL. Replay will skip it, breaking durable subscribers.
The comment at line 73 acknowledges the window but does not offer a mitigation.
**Recommendation:** Expose a `syncNow()` method on `WALWriterImpl` and await it inside `publish()` before calling `pubsub.publish()`, or invert the order: write to WAL with `syncInterval: 0`, then publish.

### H-2 — EventBus compaction is not concurrency-safe (Race)
**File:** `src/messaging/EventBus.ts:402–440`
`compact()` tears down and recreates `_walWriter` (lines 402–440). If `publish()` is called concurrently during this window (between `_walWriter = null` at line 404 and it being reassigned at line 436), the `if (this._walWriter)` guard at line 205 silently skips persistence — the event is published but not durably recorded.
`_inflightCompaction` prevents a second compaction overlap but does not block concurrent `publish()` calls.
**Recommendation:** Hold a flag that suspends `publish()` (or queues it) during the compaction window, or protect the writer reference with a mutex.

### H-3 — RateLimiter buckets grow without bound (Memory growth)
**File:** `src/common/RateLimiter.ts:24,43`
`this.buckets` is a `Map<string, Bucket>` that is only reduced by an explicit `reset(key)` call. In any scenario where the key space is unbounded (e.g., per-client-IP rate limiting, per-topic limits) the map grows forever. There is no TTL eviction, no maximum size, and no background cleanup.
**Recommendation:** Evict stale buckets lazily inside `check()` when `tokens === burstLimit && elapsed > windowMs`, or run a periodic cleanup similar to `PubSubManager`'s `cleanupDeduplicationCache`.

### H-4 — WebSocketAdapter.send() signature mismatch (Type safety / Dead code)
**File:** `src/transport/adapters/WebSocketAdapter.ts:167–180`
The abstract `Transport.send()` signature is `send(message: Message, target: NodeId): Promise<void>`, but `WebSocketAdapter.send()` ignores `target` and instead casts `message` to `GossipMessage` to inspect `.isBroadcast()` / `.header.recipient`. Any caller passing a plain `Message` (as the interface requires) receives a runtime crash when `.isBroadcast()` is invoked on an object that lacks it. The adapter effectively speaks a different protocol than the abstract base.
**Recommendation:** Either change the base class to accept `GossipMessage`, or implement proper routing inside the adapter based on `target`.

### H-5 — HTTPAdapter: only one message handler at a time (Listener leak / Silent drop)
**File:** `src/transport/adapters/HTTPAdapter.ts:202–209`
`onMessage()` stores a single `messageHandler?: (message: Message) => void` (line 26). Calling `onMessage()` a second time silently overwrites the first handler with no warning. `removeMessageListener()` checks reference equality and only clears if matched — any other listener is permanently lost. `PubSubManager` calls `onMessage()` once but code paths that register multiple listeners will silently discard all but the last.
The same pattern exists in `GRPCAdapter.ts:218`.
**Recommendation:** Use an array or `Set` of handlers (matching the pattern in `TCPAdapter` and `UDPAdapter`).

### H-6 — GRPCAdapter: `stop()` does not null `healthCheckTimer` (Timer leak)
**File:** `src/transport/adapters/GRPCAdapter.ts:166–168`
`clearInterval(this.healthCheckTimer)` is called but `this.healthCheckTimer` is not set to `undefined` afterward. If `stop()` is called twice (which is guarded by `isRunning`), the second call skips everything — but `isRunning` is set to `false` on line 163 before `clearInterval`, so a race between two concurrent `stop()` calls would double-clear a potentially stale handle.
More importantly, `handleStreamMessages` (line 298) is registered but the `StreamMessages` RPC path is never added to the `serviceDefinition` in `start()` — it is dead code that is never reachable.
**Recommendation:** Null the timer after clearing; remove `handleStreamMessages` or wire it into the service definition.

### H-7 — MessageBatcher: `addMessage()` sorts entire queue on every enqueue (Hot-path allocation)
**File:** `src/transport/MessageBatcher.ts:113–114`
Every call to `addMessage()` calls `queue.sort(...)` in-place. For a queue of N messages this is O(N log N) on every insert. In a high-throughput scenario with large queues this dominates CPU cost and allocates a sort buffer per call. Combined with the `Math.min` / `Math.random` and `Date.now()` calls per message, the per-call overhead is non-trivial.
**Recommendation:** Use an insertion-sort step (O(N) worst-case but O(1) amortized for in-order priority), or maintain a priority-bucketed array.

---

## Medium-Severity Findings

### M-1 — EventBus replay does not checkpoint: catch-up could replay millions of events (Durability / Memory)
**File:** `src/messaging/EventBus.ts:333–358`
`replay()` loads *all* WAL entries into memory (`await reader.readAll()`) before filtering by version. In a long-running bus this grows unboundedly. There is no streaming or chunked replay. For durable subscriptions with a stale checkpoint, the entire historical log is materialized.
**Recommendation:** Stream entries from WAL and filter on-the-fly; avoid `readAll()` as the API boundary.

### M-2 — PubSubManager unsubscribe is O(topics × subs) linear scan (Hot path)
**File:** `src/gateway/pubsub/PubSubManager.ts:126–142`
`unsubscribe()` iterates over all topics to find the subscription ID. With many topics this degrades to O(topics). A reverse index from `subscriptionId → topic` would make it O(1).
**Recommendation:** Maintain a `Map<string, string>` of `subscriptionId → topic` alongside the main map.

### M-3 — PubSubManager `deliverLocally()` does not await handler return values (Error swallowing)
**File:** `src/gateway/pubsub/PubSubManager.ts:207–218`
Handlers registered via `subscribe()` are of type `PubSubHandler`, which can be async. `deliverLocally` calls `subscription.handler(topic, payload, metadata)` without awaiting or catching. Any rejected promise is an unhandled rejection.
**Recommendation:** Either require synchronous handlers in the PubSub contract, or `await` and catch inside the delivery loop.

### M-4 — UpdateCoalescer `flush()` swallows errors (Error swallowing)
**File:** `src/gateway/coalescing/UpdateCoalescer.ts:64`
```ts
Promise.resolve(this.onFlush(key, payload)).catch(() => {});
```
Flush errors are silently discarded. There is no dead-letter path, no counter, no event emission. If `onFlush` throws, the buffered updates are permanently lost.
**Recommendation:** Expose an `onError?: (key: string, error: unknown) => void` option in `UpdateCoalescerOptions` and call it instead of `() => {}`.

### M-5 — BackpressureController `drain()` swallows errors indefinitely (Error swallowing)
**File:** `src/gateway/backpressure/BackpressureController.ts:124–133`
The `catch {}` comment says "items will be re-queued by flush()" — which is correct — but the loop runs 10 iterations unconditionally even when every attempt fails, burning CPU with no backoff and no signal to the caller about items that could not be flushed. If `onFlush` always throws, `drain()` returns normally after 10 failed iterations with items still in queue.
**Recommendation:** Propagate the final error or return a `DrainResult` with remaining counts; add exponential backoff between iterations.

### M-6 — RetryManager dead-letter queue and idempotency cache grow without bound (Memory growth)
**File:** `src/transport/RetryManager.ts:57–59`
`deadLetterQueue` and `idempotencyCache` are `Map` instances with no maximum size and no background eviction. The idempotency cache is cleaned per-key after 5 minutes (line 109) but only if that specific operation succeeded — failed operations accumulate in `deadLetterQueue` forever unless `clearDeadLetterQueue()` is called externally.
**Recommendation:** Add a configurable max-size and/or a periodic sweep; emit a `dead-letter:overflow` event when the limit is reached.

### M-7 — GossipMessage `calculateChecksum` uses `require('crypto')` inside hot method (Allocation)
**File:** `src/transport/GossipMessage.ts:260–263`
```ts
const crypto = require('crypto');
```
`require()` is called every time `calculateChecksum` runs — which is in both the constructor and `isValid()`. While Node.js caches `require()` results, this still incurs a property lookup and closure allocation per call. The `// eslint-disable-next-line @typescript-eslint/no-var-requires` suppression hides a deeper pattern issue.
**Recommendation:** Use a top-level `import * as crypto from 'crypto'` consistent with other transport files.

### M-8 — GRPCAdapter: `connectToNode` swallows initial-message send errors (Error swallowing)
**File:** `src/transport/adapters/GRPCAdapter.ts:410–412`
```ts
this.sendToConnection(connection, initialMessage).catch(() => {
  // Ignore initial message send errors
});
```
If the first send after connection establishment fails, the caller's `send()` call resolves successfully — the caller has no indication the message was not delivered.
**Recommendation:** Await the initial send and propagate the error, or remove the optimistic send-on-connect pattern and let the normal retry flow handle it.

### M-9 — ClientWebSocketAdapter heartbeat timer missing `.unref()` (Timer leak)
**File:** `src/transport/adapters/ClientWebSocketAdapter.ts:256–271`
`startHeartbeat()` calls `setInterval(...)` but does not call `.unref()` on the timer (compare with `WebSocketAdapter.ts:402` which does). In test environments this keeps the process alive and is the probable cause of Jest timeouts.
**Recommendation:** Add `this.heartbeatTimer.unref()` after assignment, matching the pattern in `WebSocketAdapter`.

### M-10 — TCPAdapter `send()` auto-starts the adapter silently (Unexpected lifecycle)
**File:** `src/transport/adapters/TCPAdapter.ts:145–149`
If `send()` is called before `start()`, it calls `await this.start()` which emits a `DeprecationWarning` (line 82) and silently starts a listening server. This can bind a port the caller did not intend to open and the DeprecationWarning message ("Calling start() is no longer necessary") is contradictory — it implies start() should be omitted, but auto-starting it creates the side effect anyway.
**Recommendation:** Remove the auto-start and throw `new Error('TCPAdapter not started')` for consistency with all other adapters.

---

## Low-Severity Findings

### L-1 — `as any` / untyped payloads throughout transport layer (Type safety)
**Files:**
- `src/transport/GossipMessage.ts:64,107,117` (`data: any`, `fromJSON(json: any)`)
- `src/transport/MessageBatcher.ts:22,84` (`metadata?: Record<string, any>`)
- `src/transport/RetryManager.ts:57–59` (`Map<string, any>`, `DeadLetterMessage<any>`)
- `src/transport/adapters/GRPCAdapter.ts:103,104,265,298,350–355` (`(arg: any)`, `call: any`, `callback: any`)
- `src/transport/adapters/ClientWebSocketAdapter.ts:11` (`metadata: Record<string, any>`)

These are older pre-session files; none use `CoreError` and all use direct `console.*` rather than a structured logger. Tracking as a single low item to avoid noise.

### L-2 — PubSubManager `publish()` generates two `Date.now()` and one `Math.random()` per message (Hot path allocation)
**File:** `src/gateway/pubsub/PubSubManager.ts:149,152,230`
`messageId` is a compound string including `Date.now()` + `Math.random()` (line 149). `metadata.timestamp` is a second `Date.now()` (line 153). `deliverToCluster` creates another timestamp + random for the transport `Message.id` (line 230). Three `Date.now()` calls and two `Math.random()` calls per publish is avoidable.
**Recommendation:** Capture one `now = Date.now()` per call and reuse; replace random-string ID with a monotonic counter when uniqueness (not unguessability) suffices.

### L-3 — `EventBus.unsubscribe()` iterates all type maps to find one ID (Linear scan)
**File:** `src/messaging/EventBus.ts:312–330`
Same pattern as M-2: O(types × handlers) scan to find a subscription by ID. Add a reverse index `Map<string, string>` of `subId → type`.

### L-4 — Router.route() result is silently discarded (Dead code / error swallowing)
**File:** `src/messaging/Router.ts:14–20`
`handler.handle(message, session)` returns `void`, but `MessageHandler.handle` could plausibly be async in future. More immediately, there is no error handling: if `handle()` throws, the exception propagates to the caller with no event emission. Consider wrapping in try/catch and emitting a `router:error` event.

### L-5 — TCPAdapter `messageBuffer` grows by Buffer.concat on every data chunk (Allocation in hot path)
**File:** `src/transport/adapters/TCPAdapter.ts:285`
```ts
connection.messageBuffer = Buffer.concat([connection.messageBuffer, data]);
```
Each TCP chunk creates a new heap Buffer copying all prior accumulated bytes. For long messages this degrades from O(1) to O(N²) total allocations. This is a well-known Node.js anti-pattern.
**Recommendation:** Use a ring-buffer or maintain an array of chunks and concatenate only when a complete message delimiter is found.

### L-6 — `GossipMessage.fromJSON` uses `EventEmitter.call()` (Unsafe prototype construction)
**File:** `src/transport/GossipMessage.ts:117–121`
```ts
const message = Object.create(GossipMessage.prototype);
Object.assign(message, json);
EventEmitter.call(message);
```
`Object.create` + manual `EventEmitter.call` is a fragile pattern that bypasses the constructor's `super()` chain and can leave internal EventEmitter state partially initialized. A plain `new GossipMessage()` with spreading options would be safer.

### L-7 — `SignedPubSubManager` does not forward PubSubManager `member:left` dual-emit (Event naming)
**File:** `src/gateway/pubsub/SignedPubSubManager.ts:62`
`SignedPubSubManager.subscribe()` wraps the inner `PubSubManager` subscription but `SignedPubSubManager.destroy()` calls `this.inner.destroy()` without bridging the `member-left`/`member:left` dual-emit events that `PubSubManager` emits. Callers listening on `SignedPubSubManager` for membership events will not receive them.
Cross-reference: `docs/EVENT-NAME-AUDIT.md` — `PubSubManager` events noted as non-conforming.

### L-8 — No test coverage for exact-capacity backpressure boundary (Missing edge test)
`BackpressureController.enqueue()` has three branches that execute when `queue.length < maxQueueSize`, `=== maxQueueSize` with each strategy. There is no test asserting the exact-capacity boundary (i.e., the item at index `maxQueueSize - 1` is accepted and the next is handled by the strategy). Similarly `drain()` with `maxIterations = 10` has no test validating partial-drain behavior when `onFlush` always rejects.

### L-9 — `Encryption.addKey` version counter is based on `Map.size` (Off-by-one risk)
**File:** `src/transport/Encryption.ts:105`
```ts
version: this.keys.size + 1,
```
If a key is added, removed via `cleanupOldKeys`, then another key is added, `this.keys.size + 1` can produce a version number that collides with an already-used version. `decrypt()` finds keys by version number (line 164) — a collision would decrypt with the wrong key.
**Recommendation:** Use a monotonically incrementing counter field, not `Map.size`.

---

## Counts

| Severity | Count |
|----------|-------|
| High     | 7     |
| Medium   | 10    |
| Low      | 9     |
| **Total**| **26**|

---

## Patterns That Recur

1. **Single-handler overwrite pattern** (`HTTPAdapter`, `GRPCAdapter`) — two adapters store one `messageHandler` instead of a `Set`, silently losing all but the last registration. `TCPAdapter` and `UDPAdapter` correctly use a `Set`.

2. **Linear-scan unsubscribe** (`PubSubManager.unsubscribe`, `EventBus.unsubscribe`) — both traverse all topics/types to locate a subscription by ID. A reverse-index Map is the standard fix and appears in neither.

3. **Error swallowing in flush paths** (`UpdateCoalescer.flush`, `BackpressureController.drain`, `GRPCAdapter.connectToNode`) — three separate flush/drain callers catch errors and discard them silently with `() => {}` or an ignore comment.

4. **Unbounded Map growth** (`RateLimiter.buckets`, `RetryManager.deadLetterQueue`, `RetryManager.idempotencyCache`) — three separate Maps with no maximum size, no TTL eviction, and no overflow signal.

5. **`as any` and `console.*` throughout transport layer** — all pre-session transport files (`GossipMessage`, `MessageBatcher`, `RetryManager`, `GRPCAdapter`) use untyped `any` casts and direct console logging. None use `CoreError` or the structured logger pattern established in newer primitives.

6. **Event name non-conformance (transport layer)** — all events in `CircuitBreaker`, `MessageBatcher`, `RetryManager`, and transport adapters use the legacy `hyphen-word` pattern. Already catalogued in `docs/EVENT-NAME-AUDIT.md`; not duplicated here.

---

## Action List (Prioritized)

| Priority | Item | File | Severity |
|----------|------|------|----------|
| 1 | Fix WAL flush-before-publish ordering to close the crash durability window | `EventBus.ts:205–218` | H-1 |
| 2 | Guard `publish()` during compaction; add a mutex or suspend flag | `EventBus.ts:402–440` | H-2 |
| 3 | Add TTL eviction to `RateLimiter.buckets` | `RateLimiter.ts:24` | H-3 |
| 4 | Fix `WebSocketAdapter.send()` to respect the `Transport` interface contract | `WebSocketAdapter.ts:167` | H-4 |
| 5 | Replace single-handler fields with `Set` in `HTTPAdapter` and `GRPCAdapter` | `HTTPAdapter.ts:26`, `GRPCAdapter.ts:37` | H-5 |
| 6 | Add `.unref()` to `ClientWebSocketAdapter` heartbeat timer | `ClientWebSocketAdapter.ts:256` | M-9 |
| 7 | Expose `onError` option in `UpdateCoalescer` instead of silent swallow | `UpdateCoalescer.ts:64` | M-4 |
| 8 | Add reverse-index to `PubSubManager.unsubscribe` and `EventBus.unsubscribe` | `PubSubManager.ts:126`, `EventBus.ts:312` | M-2, L-3 |
| 9 | Replace `Buffer.concat` accumulation in TCP data handler with chunk array | `TCPAdapter.ts:285` | L-5 |
| 10 | Fix `Encryption` version counter to use a monotonic field not `Map.size` | `Encryption.ts:105` | L-9 |
| 11 | Cap `RetryManager` dead-letter and idempotency maps with max-size + eviction | `RetryManager.ts:57–59` | M-6 |
| 12 | Remove TCPAdapter auto-start side-effect from `send()` | `TCPAdapter.ts:145` | M-10 |
| 13 | Add edge-case tests: exact-capacity backpressure boundary, partial drain | *(test files)* | L-8 |
