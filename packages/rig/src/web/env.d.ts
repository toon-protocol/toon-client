/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Default WebSocket relay URL, baked into the build for Arweave deployments. */
  readonly VITE_DEFAULT_RELAY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
