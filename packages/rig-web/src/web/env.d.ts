/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Default WebSocket relay URL, baked into the build for Arweave deployments. */
  readonly VITE_DEFAULT_RELAY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Rig-UI boot configuration injected by pointer HTML shells.
 * When present, takes absolute precedence over all other relay sources.
 */
interface RigConfig {
  /** WebSocket relay URL (must be ws:// or wss://) */
  relay: string;
  /** Optional repo identifier for deep-linking */
  repo?: string;
  /** Optional owner npub or hex pubkey for deep-linking */
  owner?: string;
}

interface Window {
  __RIG_CONFIG__?: RigConfig;
}
