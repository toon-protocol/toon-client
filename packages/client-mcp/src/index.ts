/**
 * `@toon-protocol/client-mcp` — library surface.
 *
 * The package ships two bins (`toon-clientd`, `toon-mcp`); this entry exposes
 * the reusable pieces for embedding / testing: the control-plane contract, the
 * HTTP control client, the persistent relay subscription, the daemon runner,
 * and the MCP tool definitions.
 */

export * from './control-api.js';
export {
  ControlClient,
  ControlApiError,
  DaemonUnreachableError,
  type ControlClientOptions,
} from './control-client.js';
export {
  RelaySubscription,
  type RelaySubscriptionOptions,
  type WebSocketFactory,
  type MinimalWebSocket,
  type DrainResult,
} from './relay-subscription.js';
export {
  ClientRunner,
  NotReadyError,
  PublishRejectedError,
  type ClientRunnerDeps,
  type ToonClientLike,
} from './daemon/client-runner.js';
export {
  resolveConfig,
  resolveMnemonic,
  readConfigFile,
  configDir,
  defaultConfigPath,
  DEFAULT_KEYSTORE_PASSWORD,
  type DaemonConfigFile,
  type ResolvedDaemonConfig,
  type ApexNegotiationConfig,
} from './daemon/config.js';
export {
  scaffoldFirstRun,
  hasConfiguredIdentity,
  defaultKeystorePath,
} from './daemon/first-run.js';
export { registerRoutes } from './daemon/routes.js';
export {
  acquireLock,
  releaseLock,
  isDaemonRunning,
  isProcessAlive,
  readPid,
  spawnDaemonDetached,
  waitForReady,
} from './daemon/lifecycle.js';
export {
  dispatchTool,
  TOOL_DEFINITIONS,
  type ToolDefinition,
  type ToolResult,
} from './mcp-tools.js';
export {
  runJourney,
  type JourneyStep,
  type JourneyPlan,
  type JourneyState,
  type JourneyStepResult,
  type JourneyResult,
} from './journey/index.js';
