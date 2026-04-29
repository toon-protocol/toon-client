import ws from 'ws';

// Node.js 20 does not expose WebSocket globally.
// The client uses WebSocket directly; polyfill it for E2E tests.
(globalThis as unknown as { WebSocket: typeof ws }).WebSocket = ws;
