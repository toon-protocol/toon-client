/**
 * Self-managed `anon` (anyone-protocol / ATOR) SOCKS5h proxy (Node.js only).
 *
 * Lets a `@toon-protocol/client` consumer reach a `.anyone` hidden service with
 * ZERO manual proxy setup: the SDK downloads, verifies, extracts, and spawns its
 * own `anon` daemon, waits for it to bootstrap + bind a loopback SOCKS5 port, and
 * hands back a `socks5h://127.0.0.1:<port>` URL. The proven reference is the
 * server-side pod entrypoint `docker/src/entrypoint-toon-client.ts` (`writeTorrc`,
 * `spawnAnon`, `waitForAnonSocks`, `tcpProbe`); this module ports that daemon
 * logic into the client package and adds the binary download + checksum gate so it
 * works without an OS-level `anon` install.
 *
 * BROWSER SAFETY: this module is dynamically imported only from `resolveTransport`
 * when a managed proxy is actually needed (Node-only path). Every Node built-in is
 * pulled in lazily via the ESM-safe `require(...)` built off `import.meta.url`
 * (the same pattern as `socks5.ts`), so a browser bundler that statically analyses
 * the package never reaches `node:child_process`/`node:fs`/`node:https`/`node:net`.
 */

import { createRequire } from 'node:module';
import type childProcessModule from 'node:child_process';
import type fsModule from 'node:fs';
import type netModule from 'node:net';
import type osModule from 'node:os';
import type pathModule from 'node:path';
import type httpsModule from 'node:https';
import type * as cryptoModule from 'node:crypto';

// ESM-safe require — see socks5.ts for the full rationale. The published bundle
// is ESM with Node built-ins external; a bare `require` would be rewritten into a
// throwing `__require` shim. Building a real require off import.meta.url keeps the
// synchronous, browser-guarded `require(...)` calls below working. This file is
// only ever dynamically imported on the Node path, so browser bundlers that tree-
// shake the static graph never include it.
const nodeRequire = createRequire(import.meta.url);

/**
 * Pinned `anon` release. "beta" is the channel slug embedded in the per-platform
 * zip asset names (e.g. `anon-beta-macos-arm64.zip`).
 */
export const ANON_VERSION = 'v0.4.10.0-beta';

const RELEASE_BASE = `https://github.com/anyone-protocol/ator-protocol/releases/download/${ANON_VERSION}`;

/**
 * Per-platform `anon` zip asset descriptor. `sha256` is the pinned checksum of the
 * release zip. All supported platforms are pinned (issue #204); the type stays
 * `string | null` and the download gate still defensively refuses a `null` entry,
 * so adding a new (not-yet-hashed) platform fails closed rather than skipping
 * verification.
 */
export interface AnonAsset {
  /** Release asset file name, e.g. `anon-beta-macos-arm64.zip`. */
  assetName: string;
  /** Pinned sha256 of the zip, or null when not yet pinned (issue #204). */
  sha256: string | null;
}

/**
 * Platform → asset map keyed by `${os.platform()}-${os.arch()}` (Node values).
 * Only macOS + Linux on x64/arm64 are supported (the `anon` releases that ship a
 * SOCKS-capable binary). Windows is intentionally absent.
 *
 * Pinned checksums (issue #204): all four supported platforms are pinned to the
 * sha256 of the `v0.4.10.0-beta` release zips (downloaded + hashed; the
 * darwin-arm64 value matches the previously-verified manual flow).
 */
export const ANON_ASSETS: Record<string, AnonAsset> = {
  'darwin-arm64': {
    assetName: 'anon-beta-macos-arm64.zip',
    sha256: '3b8724afc56354aa93d2fe804d6b8a685d3bff65dac0ca3384cae1ef010977b2',
  },
  'darwin-x64': {
    assetName: 'anon-beta-macos-amd64.zip',
    sha256: 'aad277849b1e63baa75891b9e5109683534e488776ff190e884e34caa04a6d54',
  },
  'linux-x64': {
    assetName: 'anon-beta-linux-amd64.zip',
    sha256: '370c86f366e7f4cad896e2ef4bbd366a4e78a832c8d58064012f86c88c411a6b',
  },
  'linux-arm64': {
    assetName: 'anon-beta-linux-arm64.zip',
    sha256: '382d21db1052b6a0f1581bf38c9cf79b370719e313781c0eba53ef0d9570334a',
  },
};

/**
 * Resolves the `anon` release asset for a platform/arch pair (Node
 * `os.platform()` / `os.arch()` values).
 *
 * @throws If the platform/arch combination has no known `anon` asset.
 */
export function selectAnonAsset(platform: string, arch: string): AnonAsset {
  const key = `${platform}-${arch}`;
  const asset = ANON_ASSETS[key];
  if (!asset) {
    throw new Error(
      `No managed anon binary available for platform "${platform}" arch "${arch}". ` +
        `Supported: ${Object.keys(ANON_ASSETS).join(', ')}. ` +
        'Provide an explicit transport.socksProxy or set ANYONE_PROXY_URLS to use your own proxy.'
    );
  }
  return asset;
}

/**
 * Default cache directory for the downloaded/extracted `anon` binary.
 * Honours `XDG_CACHE_HOME`; otherwise `~/.toon-client/anon`.
 */
export function defaultCacheDir(): string {
  const os = nodeRequire('node:os') as typeof osModule;
  const path = nodeRequire('node:path') as typeof pathModule;
  const xdg = process.env['XDG_CACHE_HOME'];
  if (xdg) {
    return path.join(xdg, 'toon-client', 'anon', ANON_VERSION);
  }
  return path.join(os.homedir(), '.toon-client', 'anon', ANON_VERSION);
}

/**
 * Renders a SOCKS-only torrc. Mirrors `writeTorrc` in the proven docker
 * entrypoint. `AgreeToTerms 1` is REQUIRED — omitting it makes `anon` exit
 * immediately.
 */
export function renderTorrc(cacheDir: string, socksPort: number): string {
  const path = nodeRequire('node:path') as typeof pathModule;
  return [
    'AgreeToTerms 1',
    `DataDirectory ${path.join(cacheDir, 'data')}`,
    `SOCKSPort 127.0.0.1:${socksPort}`,
    'SOCKSPolicy accept *',
    `GeoIPFile ${path.join(cacheDir, 'geoip')}`,
    `GeoIPv6File ${path.join(cacheDir, 'geoip6')}`,
    'Log notice stdout',
    'RunAsDaemon 0',
    '',
  ].join('\n');
}

/**
 * Simple TCP connect probe — confirms the SOCKS5 port has bound and accepts
 * connections. Mirrors `tcpProbe` in the docker entrypoint / `probeSocks5Proxy`.
 */
export async function tcpProbe(
  host: string,
  port: number,
  timeoutMs: number
): Promise<void> {
  const net = nodeRequire('node:net') as typeof netModule;
  return new Promise<void>((resolve, reject) => {
    const sock = net.createConnection({ host, port }, () => {
      sock.destroy();
      resolve();
    });
    sock.once('error', (err: Error) => {
      sock.destroy();
      reject(err);
    });
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      reject(new Error('timeout'));
    });
  });
}

/**
 * Computes the sha256 (hex) of a file using node:crypto streaming.
 */
async function sha256File(filePath: string): Promise<string> {
  const fs = nodeRequire('node:fs') as typeof fsModule;
  const crypto = nodeRequire('node:crypto') as typeof cryptoModule;
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Downloads a URL to a file, following GitHub release redirects. Node-only
 * (node:https + node:fs).
 */
async function downloadToFile(url: string, destPath: string): Promise<void> {
  const fs = nodeRequire('node:fs') as typeof fsModule;
  const https = nodeRequire('node:https') as typeof httpsModule;

  const fetchOnce = (u: string, redirectsLeft: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const req = https.get(u, (res) => {
        const status = res.statusCode ?? 0;
        // GitHub release assets redirect to a signed S3 URL.
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects downloading ${url}`));
            return;
          }
          resolve(fetchOnce(res.headers.location, redirectsLeft - 1));
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`Download failed (HTTP ${status}) for ${u}`));
          return;
        }
        const out = fs.createWriteStream(destPath);
        res.pipe(out);
        out.on('error', reject);
        out.on('finish', () => out.close(() => resolve()));
      });
      req.on('error', reject);
      req.setTimeout(120_000, () => {
        req.destroy(new Error(`Download timeout for ${u}`));
      });
    });

  await fetchOnce(url, 5);
}

/**
 * Extracts a zip into a directory by shelling out to the system `unzip` binary
 * (present on macOS + Linux). Kept here (not a JS unzip dep) to avoid adding a
 * runtime dependency to the browser-facing client package.
 */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const cp = nodeRequire('node:child_process') as typeof childProcessModule;
  await new Promise<void>((resolve, reject) => {
    const child = cp.spawn('unzip', ['-o', zipPath, '-d', destDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err: Error) =>
      reject(
        new Error(`Failed to spawn unzip (is it installed?): ${err.message}`)
      )
    );
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`unzip exited ${code} extracting ${zipPath}: ${stderr}`)
        );
    });
  });
}

/**
 * Ensures a verified `anon` binary exists in the cache directory, downloading +
 * checksum-verifying + extracting it if not. Returns the absolute path to the
 * extracted `anon` executable.
 *
 * Skips re-download when a previously extracted `anon` binary is already present
 * (the checksum gate runs on the freshly downloaded zip; an already-extracted
 * binary in a version-pinned cache dir is trusted).
 */
export async function ensureAnonBinary(opts: {
  cacheDir: string;
  platform: string;
  arch: string;
  /** Injectable downloader (tests). Default: node:https GET with redirects. */
  download?: (url: string, destPath: string) => Promise<void>;
  /** Injectable extractor (tests). Default: shell out to `unzip`. */
  extract?: (zipPath: string, destDir: string) => Promise<void>;
}): Promise<string> {
  const fs = nodeRequire('node:fs') as typeof fsModule;
  const path = nodeRequire('node:path') as typeof pathModule;

  const download = opts.download ?? downloadToFile;
  const extract = opts.extract ?? extractZip;

  const asset = selectAnonAsset(opts.platform, opts.arch);
  const anonPath = path.join(opts.cacheDir, 'anon');

  // Fast path: already extracted (version-pinned cache dir).
  if (fs.existsSync(anonPath)) {
    return anonPath;
  }

  if (asset.sha256 === null) {
    throw new Error(
      `Managed anon binary for "${opts.platform}-${opts.arch}" ` +
        `(${asset.assetName}) has no pinned checksum yet (see issue #204). ` +
        'Provide an explicit transport.socksProxy to use your own proxy.'
    );
  }

  fs.mkdirSync(opts.cacheDir, { recursive: true });
  const zipPath = path.join(opts.cacheDir, asset.assetName);
  const url = `${RELEASE_BASE}/${asset.assetName}`;

  await download(url, zipPath);

  const actual = await sha256File(zipPath);
  if (actual !== asset.sha256) {
    // Remove the bad artifact so a retry re-downloads cleanly.
    try {
      fs.rmSync(zipPath, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw new Error(
      `Checksum mismatch for ${asset.assetName}: expected ${asset.sha256}, got ${actual}. ` +
        'Refusing to run an unverified anon binary.'
    );
  }

  await extract(zipPath, opts.cacheDir);

  if (!fs.existsSync(anonPath)) {
    throw new Error(
      `Extraction of ${asset.assetName} did not produce an "anon" binary at ${anonPath}.`
    );
  }
  // Ensure executable (zip may not preserve the bit on all platforms).
  try {
    fs.chmodSync(anonPath, 0o755);
  } catch {
    /* best-effort */
  }
  return anonPath;
}

/**
 * Polls for the SOCKS5 port to bind. `anon` typically takes 30-90s to bootstrap
 * (build a circuit + consensus) before SOCKS5 accepts connections. Mirrors
 * `waitForAnonSocks` in the docker entrypoint, but also fails fast if the child
 * exits before binding.
 */
export async function waitForAnonSocks(opts: {
  port: number;
  deadlineMs: number;
  childExited: () => boolean;
  log: (msg: string) => void;
  probe?: (host: string, port: number, timeoutMs: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const probe = opts.probe ?? tcpProbe;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  opts.log(`[anon] waiting for SOCKS5 bind on 127.0.0.1:${opts.port}…`);
  let lastErr: string | null = null;
  while (Date.now() < opts.deadlineMs) {
    if (opts.childExited()) {
      throw new Error('[anon] process exited before SOCKS5 port bound');
    }
    try {
      await probe('127.0.0.1', opts.port, 2_000);
      opts.log(`[anon] SOCKS5 bound on 127.0.0.1:${opts.port}`);
      return;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== lastErr) {
        opts.log(`[anon] SOCKS5 not ready: ${msg}`);
        lastErr = msg;
      }
    }
    await sleep(2_000);
  }
  throw new Error(
    `[anon] SOCKS5 never bound on 127.0.0.1:${opts.port} by deadline`
  );
}

/**
 * Handle returned by `startManagedAnonProxy`. `socksProxy` is the loopback
 * `socks5h://` URL to wire into `transport: { type: 'socks5', socksProxy }`.
 * `stop()` SIGTERMs the daemon and is idempotent.
 */
export interface ManagedAnonProxy {
  socksProxy: string;
  stop(): Promise<void>;
}

/**
 * Options for `startManagedAnonProxy`. All have sensible defaults; tests inject
 * the deps to avoid real downloads/spawns.
 */
export interface StartManagedAnonProxyOptions {
  /** Cache dir for the binary + torrc + data. Default: {@link defaultCacheDir}. */
  cacheDir?: string;
  /** Loopback SOCKS5 port. Default 9050. */
  socksPort?: number;
  /** Bootstrap deadline in ms. Default 180_000. */
  bootstrapTimeoutMs?: number;
  /** Logger. Default: no-op. */
  log?: (msg: string) => void;
  /** os.platform() override (tests). */
  platform?: string;
  /** os.arch() override (tests). */
  arch?: string;
}

/**
 * Downloads (if needed) + spawns a managed `anon` daemon and waits for its SOCKS5
 * port to bind. Returns a {@link ManagedAnonProxy} whose `socksProxy` is ready for
 * `transport: { type: 'socks5', socksProxy }`.
 *
 * @throws If the platform is unsupported, the checksum fails, or anon never binds.
 */
export async function startManagedAnonProxy(
  options: StartManagedAnonProxyOptions = {}
): Promise<ManagedAnonProxy> {
  const fs = nodeRequire('node:fs') as typeof fsModule;
  const path = nodeRequire('node:path') as typeof pathModule;
  const os = nodeRequire('node:os') as typeof osModule;
  const cp = nodeRequire('node:child_process') as typeof childProcessModule;

  const platform = options.platform ?? os.platform();
  const arch = options.arch ?? os.arch();
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const socksPort = options.socksPort ?? 9050;
  const bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? 180_000;
  const log =
    options.log ??
    ((): void => {
      /* default: silent */
    });

  const anonPath = await ensureAnonBinary({ cacheDir, platform, arch });

  // Write the SOCKS-only torrc.
  fs.mkdirSync(path.join(cacheDir, 'data'), { recursive: true });
  const torrcPath = path.join(cacheDir, 'torrc');
  fs.writeFileSync(torrcPath, renderTorrc(cacheDir, socksPort), {
    mode: 0o644,
  });

  log(`[anon] spawning: ${anonPath} -f ${torrcPath}`);
  const child = cp.spawn(anonPath, ['-f', torrcPath], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: false,
  });
  let exited = false;
  child.on('exit', (code, signal) => {
    exited = true;
    log(`[anon] child exited code=${code} signal=${signal}`);
  });
  child.on('error', (err: Error) => {
    log(`[anon] spawn error: ${err.message}`);
  });

  const stop = async (): Promise<void> => {
    if (!child.killed && !exited) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
    }
  };

  try {
    await waitForAnonSocks({
      port: socksPort,
      deadlineMs: Date.now() + bootstrapTimeoutMs,
      childExited: () => exited,
      log,
    });
  } catch (err) {
    await stop();
    throw err;
  }

  return {
    socksProxy: `socks5h://127.0.0.1:${socksPort}`,
    stop,
  };
}
