#!/usr/bin/env node
/**
 * `toon-clientd` — the always-on, detached TOON client daemon. It owns the two
 * long-lived connections that cannot live in an ephemeral agent session:
 *   • a BTP session to the apex/connector (paid writes), and
 *   • a persistent town-relay Nostr-WS subscription (free reads),
 * plus the payment channels (with a persisted nonce watermark) and the signer.
 *
 * Subcommands:
 *   toon-clientd run      Run the daemon in the foreground (used internally by
 *                         the detached spawn; logs to stdout).
 *   toon-clientd start    Spawn the daemon detached and wait until reachable.
 *   toon-clientd stop     Stop a running daemon (SIGTERM the locked PID).
 *   toon-clientd status   Print the daemon status as JSON.
 */

import Fastify from 'fastify';
import { ToonClient } from '@toon-protocol/client';
import {
  defaultConfigPath,
  readConfigFile,
  resolveConfig,
  type ResolvedDaemonConfig,
} from './daemon/config.js';
import { scaffoldFirstRun } from './daemon/first-run.js';
import { ClientRunner, type ToonClientLike } from './daemon/client-runner.js';
import { registerRoutes } from './daemon/routes.js';
import {
  acquireLock,
  isProcessAlive,
  readPid,
  releaseLock,
  spawnDaemonDetached,
  waitForReady,
} from './daemon/lifecycle.js';
import { ControlClient } from './control-client.js';

function baseUrl(config: ResolvedDaemonConfig): string {
  return `http://127.0.0.1:${config.httpPort}`;
}

function loadResolvedConfig(): ResolvedDaemonConfig {
  const path = process.env['TOON_CLIENT_CONFIG'] ?? defaultConfigPath();
  return resolveConfig(readConfigFile(path));
}

/** Run the daemon in the foreground (the detached child's actual work). */
async function runForeground(): Promise<void> {
  acquireLock();
  const config = loadResolvedConfig();
  const log = (msg: string): void => console.error(msg);

  const runner = new ClientRunner({
    config,
    createClient: (clientConfig) =>
      new ToonClient(clientConfig) as unknown as ToonClientLike,
    logger: log,
  });

  const app = Fastify({ logger: false });
  registerRoutes(app, runner);

  // Begin bootstrap (non-blocking) before listening so /status is immediately
  // reachable and reports `bootstrapping: true` while anon/BTP come up.
  runner.start();

  await app.listen({ host: '127.0.0.1', port: config.httpPort });
  log(`[toon-clientd] listening on ${baseUrl(config)}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[toon-clientd] received ${signal}, shutting down`);
    try {
      await app.close();
    } catch {
      /* ignore */
    }
    await runner.stop();
    releaseLock();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/** Spawn the daemon detached and wait until the control plane responds. */
async function start(): Promise<void> {
  const config = loadResolvedConfig();
  const url = baseUrl(config);
  const existing = readPid();
  if (existing !== null && isProcessAlive(existing)) {
    console.log(`toon-clientd already running (pid ${existing}) at ${url}`);
    return;
  }
  const pid = spawnDaemonDetached();
  const ok = await waitForReady(url, 20_000);
  if (ok) {
    console.log(`toon-clientd started (pid ${pid}) at ${url}`);
  } else {
    console.error(
      `toon-clientd spawned (pid ${pid}) but did not become reachable at ${url} in time. ` +
        `Check the daemon log.`
    );
    process.exitCode = 1;
  }
}

/** Stop a running daemon via SIGTERM on the locked PID. */
async function stop(): Promise<void> {
  const pid = readPid();
  if (pid === null || !isProcessAlive(pid)) {
    console.log('toon-clientd is not running');
    releaseLock();
    return;
  }
  process.kill(pid, 'SIGTERM');
  // Wait briefly for the process to exit.
  for (let i = 0; i < 40; i++) {
    if (!isProcessAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`toon-clientd stopped (pid ${pid})`);
}

/** Print the daemon status JSON. */
async function status(): Promise<void> {
  const config = loadResolvedConfig();
  const client = new ControlClient({ baseUrl: baseUrl(config) });
  try {
    const s = await client.status();
    console.log(JSON.stringify(s, null, 2));
  } catch {
    console.log(JSON.stringify({ running: false }, null, 2));
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'run';
  switch (cmd) {
    case 'run':
      // First-run onboarding (#251): mint + persist an identity and scaffold
      // the transport config so a fresh install starts with no manual setup.
      await scaffoldFirstRun();
      await runForeground();
      break;
    case 'start':
      await scaffoldFirstRun();
      await start();
      break;
    case 'stop':
      await stop();
      break;
    case 'status':
      await status();
      break;
    default:
      console.error(
        `Unknown command "${cmd}". Usage: toon-clientd <run|start|stop|status>`
      );
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err)
  );
  process.exitCode = 1;
});
