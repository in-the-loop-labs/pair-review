# SSE to WebSocket Migration

## Context

With 6 PRs open in 6 tabs, the app hangs. Root cause: browsers enforce a 6-connection-per-origin limit for HTTP/1.1. Each tab opens up to 3 SSE connections (chat stream + analysis progress + setup progress), exhausting the limit at just 2 tabs. WebSocket connections don't count against this limit (~255 allowed per origin). This migration replaces all SSE endpoints with a single WebSocket connection per tab using topic-based pub/sub.

## Design

**Single WebSocket connection per tab.** Server-side topic-based routing replaces client-side filtering.

**Protocol:**
```
Client → Server:  { "action": "subscribe", "topic": "review:42" }
Client → Server:  { "action": "unsubscribe", "topic": "review:42" }
Server → Client:  { "topic": "review:42", "type": "comment_added", ... }
```

**Topics:**
- `chat:{sessionId}` — streaming chat events (delta, tool_use, complete, status, error)
- `review:{reviewId}` — review-level events (comments_changed, suggestions_changed, analysis_started, analysis_completed, context_files_changed, expand_hunk)
- `analysis:{analysisId}` — analysis progress updates
- `setup:{setupId}` — setup progress (step, complete, error)

**Key decision — initial state on subscribe:** The current SSE analysis endpoint sends cached state on connect. With WebSocket, the client instead fetches initial state via the existing `GET /api/analyses/:id/status` HTTP endpoint after subscribing. This keeps the WS server purely pub/sub with no domain knowledge.

**Key decision — minimal import churn:** Broadcast wrapper functions (`broadcastReviewEvent`, `broadcastProgress`, `broadcastSSE`, etc.) keep their signatures and file locations. Only their internals change to call `ws.broadcast()`. Route files that call these functions need zero changes.

---

## Phase 1: WebSocket Server Infrastructure (additive, nothing breaks)

### New files

**`src/ws/server.js`** — Core pub/sub server
- `attachWebSocket(httpServer)` — creates `WebSocketServer` in `noServer` mode, handles `upgrade` events on path `/ws`
- `broadcast(topic, payload)` — JSON-stringify once, send to all clients subscribed to `topic`
- Heartbeat: ping every 30s, terminate unresponsive connections after 10s
- On client message: parse JSON, handle `subscribe`/`unsubscribe` by maintaining `ws._topics` Set per connection
- On close/error: clean up client subscriptions
- `closeAll()` for graceful shutdown
- Export: `{ attachWebSocket, broadcast, closeAll }` plus `_wss` for tests

**`src/ws/index.js`** — Re-exports from server.js

### Modified files

**`src/server.js`** (~line 63 in `startServer()`)
- After `server = app.listen(...)`: call `attachWebSocket(server)`
- In `gracefulShutdown()`: call `closeAll()` before `server.close()`

**`package.json`**
- Add `ws` dependency

### Tests
- `tests/unit/ws-server.test.js` — subscribe, unsubscribe, broadcast routing, dead client cleanup, heartbeat

---

## Phase 2: Client WebSocket Wrapper (additive, nothing breaks)

### New files

**`public/js/ws-client.js`** — Browser-side singleton
- `window.wsClient = new WSClient()` — auto-connects on load
- `connect()` — builds `ws://` or `wss://` URL to `{origin}/ws`
- `subscribe(topic, callback)` → returns unsubscribe function
- Auto-reconnect with exponential backoff (1s → 10s cap)
- On reconnect: re-sends all active subscriptions
- Tracks subscriptions in `Map<topic, Set<callback>>`
- On message: parse JSON, dispatch to callbacks for `msg.topic`

### Modified files

**`public/pr.html`**, **`public/local.html`**, **`public/setup.html`**
- Add `<script src="/js/ws-client.js"></script>` before component scripts

### Tests
- `tests/unit/ws-client.test.js` — subscribe/unsubscribe, message dispatch, reconnect with re-subscription

---

## Phase 3: Swap Server-Side Broadcasting (the core swap)

### Modified files

**`src/sse/review-events.js`** — rewrite internals
- `broadcastReviewEvent(reviewId, payload, options)` now calls `broadcast('review:' + reviewId, envelope)` from `src/ws`
- Remove `sseClients` Set entirely
- Signature unchanged — all 6 route file callers need zero changes

**`src/routes/shared.js`** — rewrite broadcast functions
- `broadcastProgress(analysisId, progressData)` now calls `broadcast('analysis:' + analysisId, ...)`
- Also broadcast on `analysis:review-${reviewId}` key when `reviewId` present (preserves external-results broadcast pattern)
- `broadcastSetupProgress(setupId, data)` now calls `broadcast('setup:' + setupId, data)`
- Remove `progressClients` Map and `setupProgressClients` Map
- `createProgressCallback` unchanged (it calls `broadcastProgress` internally, which now routes through WS)

**`src/routes/chat.js`**
- `broadcastSSE(sessionId, payload)` now calls `broadcast('chat:' + sessionId, ...)` from `src/ws`
- Remove `GET /api/chat/stream` SSE endpoint (~lines 411-433)
- Remove `sseClients` import from `../sse/review-events`
- Keep `registerSSEBroadcast`/`unregisterSSEBroadcast` (they wire chat session callbacks to `broadcastSSE` — still needed, rename later if desired)

**`src/routes/analyses.js`**
- Remove `GET /api/analyses/:id/progress` SSE endpoint (~lines 448-510)
- Remove `progressClients` import from shared.js (only used for SSE client registration)
- Keep `GET /api/analyses/:id/status` HTTP endpoint (used by client for initial state fetch)

**`src/routes/setup.js`**
- Remove `GET /api/setup/pr/:owner/:repo/:number/progress` SSE endpoint
- Remove `GET /api/setup/local/:setupId/progress` SSE endpoint
- `sendSetupSSE(setupId, eventType, data)` now calls `broadcastSetupProgress(setupId, { type: eventType, ...data })`
- Remove `setupProgressClients` import

### Route files that need NO changes
- `src/routes/pr.js`, `src/routes/local.js`, `src/routes/reviews.js`, `src/routes/context-files.js`, `src/routes/mcp.js`

### Tests to update
- `tests/unit/review-events.test.js` — mock `ws.broadcast` instead of fake `{ write }` clients
- `tests/unit/shared.test.js` — mock `ws.broadcast` instead of `progressClients` Map
- `tests/integration/chat-routes.test.js` — remove SSE endpoint tests, mock `ws.broadcast` for broadcastSSE tests
- `tests/integration/analysis-results.test.js` — mock `ws.broadcast` instead of `progressClients.set()`

---

## Phase 4: Swap Client-Side Consumers

### Modified files

**`public/js/components/ChatPanel.js`**
- Replace `_ensureGlobalSSE()`: subscribe to `chat:{sessionId}` and `review:{reviewId}` via `window.wsClient.subscribe()`
- `subscribe()` returns unsubscribe fn — store and call on session/review change
- Remove `this.eventSource`, `_sseReconnectTimer`, all EventSource references
- Move existing `onmessage` handler logic into a `_handleChatMessage(msg)` method (no JSON.parse needed, wsClient already parsed)
- Review event routing stays the same: dispatch `CustomEvent` to `document` for review-scoped events

**`public/js/components/CouncilProgressModal.js`**
- `startProgressMonitoring()`: subscribe to `analysis:{analysisId}` via `window.wsClient.subscribe()`
- `stopProgressMonitoring()`: call stored unsubscribe function
- Remove `this.eventSource` references
- Keep `_fallbackToPolling()` as safety net (uses HTTP fetch, not SSE)

**`public/setup.html`** (inline JS)
- Replace `connectSSE(url)` with WebSocket subscription: `window.wsClient.subscribe('setup:' + setupId, handler)`
- Handler dispatches on `msg.type` (`step`, `complete`, `error`) instead of named SSE events

**`public/js/pr.js`**
- In `_initReviewEventListeners()`: the call to `window.chatPanel?._ensureGlobalSSE()` stays (ChatPanel internally now subscribes via WS)
- No other changes needed

### Tests to update
- `tests/unit/chat-panel.test.js` — mock `window.wsClient` instead of `global.EventSource`
- `tests/unit/council-progress-modal.test.js` — mock `window.wsClient` instead of `window.EventSource`

---

## Phase 5: Cleanup

- Remove `sseClients` export from `src/sse/review-events.js`
- Remove `_sseClients` / `_sseUnsubscribers` test-only exports from `src/routes/chat.js`
- Remove `progressClients` / `setupProgressClients` from `src/routes/shared.js` exports
- Consider renaming `src/sse/` directory (optional, low priority)
- Final test pass: ensure no references to `EventSource`, `sseClients`, `progressClients`, `setupProgressClients` remain

---

## Verification

1. `npm test` — all unit and integration tests pass
2. `npm run test:e2e` — E2E tests pass (covers analysis progress, chat, comments)
3. Manual: open 6+ PR tabs simultaneously — no hanging, all real-time updates work
4. Manual: trigger AI analysis in one tab — progress updates stream correctly
5. Manual: add a comment in one tab — other tabs for same review update
6. Manual: disconnect network briefly — WebSocket reconnects and re-subscribes
7. Browser DevTools Network tab: confirm only 1 WebSocket connection per tab, zero SSE connections

## Changeset

Create a `minor` changeset — this is a new transport mechanism (user-facing: fixes multi-tab reliability).
