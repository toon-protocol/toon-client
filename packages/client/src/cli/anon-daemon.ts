/**
 * The managed `anon` daemon — the CLI's, and only the CLI's (ADR 0001).
 *
 * Reaching a hidden-service connector takes a running Anyone Protocol daemon and
 * a SOCKS port. `@toon-protocol/client` never provides one: a library that an
 * application embeds must not download and execute a binary at runtime. The
 * `toon` command may, because running it is already a decision to run our
 * executable — so this module lives under `src/cli/`, which is a separate build
 * entry that a library consumer never loads.
 *
 * The release is pinned and checksummed, and the gate fails **closed**: an asset
 * whose hash is unknown is not downloaded at all, rather than downloaded and
 * trusted. A platform we have no pinned hash for is a platform this command
 * cannot serve.
 */
import { createRequire } from 'node:module';
import type childProcessModule from 'node:child_process';
import type cryptoModule from 'node:crypto';
import type fsModule from 'node:fs';
import type httpsModule from 'node:https';
import type netModule from 'node:net';
import type osModule from 'node:os';
import type pathModule from 'node:path';

const nodeRequire = createRequire(import.meta.url);

/**
 * The pinned `anon` release.
 *
 * `live` is the stable channel. There are newer `-beta` tags, and a payer should
 * not be shipped a beta daemon by default. The channel slug is embedded in every
 * asset name (`anon-live-linux-amd64.zip`), which is why it moves with the
 * version rather than being a separate knob.
 */
export const ANON_VERSION = 'v0.4.10.2';

const RELEASE_BASE = `https://github.com/anyone-protocol/ator-protocol/releases/download/${ANON_VERSION}`;

/** One platform's release asset, and the hash it must have. */
export interface AnonAsset {
  assetName: string;
  /** sha256 of the zip, or `null` when unpinned — which refuses the download. */
  sha256: string | null;
}

/**
 * Platform → asset, keyed by `${os.platform()}-${os.arch()}`.
 *
 * Windows is here now: earlier versions of this map excluded it because no
 * Windows asset existed, and `v0.4.10.2` ships a signed one.
 */
export const ANON_ASSETS: Record<string, AnonAsset> = {
  'linux-x64': {
    assetName: 'anon-live-linux-amd64.zip',
    sha256: '9c6498b8d27de54d78842a1b854979a605f9c140ccc34f2b4c267bf094eaeb17',
  },
  'linux-arm64': {
    assetName: 'anon-live-linux-arm64.zip',
    sha256: 'daa3ed15f321d83f22b9c03fad2c0f908e60e3e156d143774bd38194244ebec9',
  },
  'darwin-x64': {
    assetName: 'anon-live-macos-amd64.zip',
    sha256: '38b5b7ce1ed847e791e56697385365918fbcf81d08def0d389abd8e31e58b975',
  },
  'darwin-arm64': {
    assetName: 'anon-live-macos-arm64.zip',
    sha256: '8f662cc5ecba27b5ec07dbed897894bd6f0e6c5ff33ca01f3a1d19544ac67866',
  },
  'win32-x64': {
    assetName: 'anon-live-windows-signed-amd64.zip',
    sha256: 'e7352c4436e2043cfe505a35f1f412e01c72a5aa671cb85af2dcf97da83df4ab',
  },
};

/** The asset for a platform/arch pair, or an error naming what is supported. */
export function selectAnonAsset(platform: string, arch: string): AnonAsset {
  const asset = ANON_ASSETS[`${platform}-${arch}`];
  if (!asset) {
    throw new Error(
      `No pinned anon binary for ${platform}-${arch}. Supported: ` +
        `${Object.keys(ANON_ASSETS).join(', ')}. Run your own daemon and pass --socks instead.`
    );
  }
  return asset;
}

/** Where the binary and its data live between runs. */
export function defaultCacheDir(): string {
  const os = nodeRequire('node:os') as typeof osModule;
  const path = nodeRequire('node:path') as typeof pathModule;
  const xdg = process.env['XDG_CACHE_HOME'];
  return xdg
    ? path.join(xdg, 'toon', 'anon', ANON_VERSION)
    : path.join(os.homedir(), '.toon', 'anon', ANON_VERSION);
}

/**
 * A SOCKS-only torrc.
 *
 * `AgreeToTerms 1` is REQUIRED: without it `anon` exits immediately, and the
 * failure reads as "the daemon died" rather than "you did not accept the terms".
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

/** A running daemon, and the way to stop it. */
export interface ManagedAnon {
  /** `socks5h://127.0.0.1:<port>` — what to configure a client with. */
  socksProxy: string;
  port: number;
  stop(): void;
}

export interface StartManagedAnonOptions {
  cacheDir?: string;
  /** Where progress goes. The CLI passes something that prints. */
  log?: (message: string) => void;
  /** How long to wait for the SOCKS port to open. Default 90s. */
  bootstrapTimeoutMs?: number;
}

/**
 * Downloads (once), verifies, spawns and waits for `anon`.
 *
 * Announced, not silent: a first run downloads ~15MB and then waits for the
 * daemon to bootstrap, and an unexplained thirty-second pause reads as a hang.
 */
export async function startManagedAnon(options: StartManagedAnonOptions = {}): Promise<ManagedAnon> {
  const fs = nodeRequire('node:fs') as typeof fsModule;
  const path = nodeRequire('node:path') as typeof pathModule;
  const cp = nodeRequire('node:child_process') as typeof childProcessModule;

  const log = options.log ?? ((): void => undefined);
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const anonPath = await ensureAnonBinary(cacheDir, log);
  const port = await freePort();

  fs.mkdirSync(path.join(cacheDir, 'data'), { recursive: true, mode: 0o700 });
  const torrcPath = path.join(cacheDir, 'torrc');
  fs.writeFileSync(torrcPath, renderTorrc(cacheDir, port), { mode: 0o600 });

  log(`starting anon ${ANON_VERSION} on 127.0.0.1:${port} (${anonPath})`);
  const child = cp.spawn(anonPath, ['-f', torrcPath], { stdio: ['ignore', 'pipe', 'pipe'] });

  let exited = false;
  let lastLine = '';
  child.on('exit', () => {
    exited = true;
  });
  child.stdout?.on('data', (data: Buffer) => {
    lastLine = data.toString().trim().split('\n').pop() ?? lastLine;
  });
  child.stderr?.on('data', (data: Buffer) => {
    lastLine = data.toString().trim().split('\n').pop() ?? lastLine;
  });

  const stop = (): void => {
    if (!exited) child.kill('SIGTERM');
  };

  try {
    await waitForSocksPort(port, options.bootstrapTimeoutMs ?? 90_000, () => exited, () => lastLine);
  } catch (error) {
    stop();
    throw error;
  }

  log(`anon is listening; building circuits on demand`);
  return { socksProxy: `socks5h://127.0.0.1:${port}`, port, stop };
}

/** The binary's path, downloading and verifying it if this is the first run. */
export async function ensureAnonBinary(
  cacheDir: string,
  log: (message: string) => void = () => undefined
): Promise<string> {
  const fs = nodeRequire('node:fs') as typeof fsModule;
  const path = nodeRequire('node:path') as typeof pathModule;
  const os = nodeRequire('node:os') as typeof osModule;

  const exe = os.platform() === 'win32' ? 'anon.exe' : 'anon';
  const anonPath = path.join(cacheDir, exe);
  if (fs.existsSync(anonPath)) return anonPath;

  const asset = selectAnonAsset(os.platform(), os.arch());
  if (asset.sha256 === null) {
    // Fail closed. An unpinned asset is one nobody has verified, and silently
    // skipping the check would make the gate decorative.
    throw new Error(
      `The anon asset ${asset.assetName} has no pinned checksum, so it will not be ` +
        'downloaded. Run your own daemon and pass --socks.'
    );
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const zipPath = path.join(cacheDir, asset.assetName);
  const url = `${RELEASE_BASE}/${asset.assetName}`;
  log(`downloading ${asset.assetName} (${ANON_VERSION})…`);
  await downloadToFile(url, zipPath);

  const actual = await sha256File(zipPath);
  if (actual !== asset.sha256) {
    fs.rmSync(zipPath, { force: true });
    throw new Error(
      `Checksum mismatch for ${asset.assetName}: expected ${asset.sha256}, got ${actual}. ` +
        'The download was discarded.'
    );
  }

  log('verified; extracting');
  await extractZip(zipPath, cacheDir);
  fs.rmSync(zipPath, { force: true });
  if (os.platform() !== 'win32') fs.chmodSync(anonPath, 0o755);
  return anonPath;
}

/** sha256 of a file, streamed — these zips are ~15MB. */
async function sha256File(filePath: string): Promise<string> {
  const fs = nodeRequire('node:fs') as typeof fsModule;
  const crypto = nodeRequire('node:crypto') as typeof cryptoModule;
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

/** GitHub release assets redirect to a signed URL, so follow a few. */
async function downloadToFile(url: string, destPath: string): Promise<void> {
  const fs = nodeRequire('node:fs') as typeof fsModule;
  const https = nodeRequire('node:https') as typeof httpsModule;

  const once = (target: string, redirectsLeft: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const req = https.get(target, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error(`Too many redirects downloading ${url}`));
          return resolve(once(res.headers.location, redirectsLeft - 1));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`Download failed (HTTP ${status}) for ${target}`));
        }
        const out = fs.createWriteStream(destPath);
        res.pipe(out);
        out.on('error', reject);
        out.on('finish', () => out.close(() => resolve()));
      });
      req.on('error', reject);
      req.setTimeout(120_000, () => req.destroy(new Error(`Download timeout for ${target}`)));
    });

  await once(url, 5);
}

/** No zip reader in Node, so borrow the platform's. */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const cp = nodeRequire('node:child_process') as typeof childProcessModule;
  const os = nodeRequire('node:os') as typeof osModule;

  const [command, args] =
    os.platform() === 'win32'
      ? ([
          'powershell',
          ['-NoProfile', '-Command', `Expand-Archive -Force -Path "${zipPath}" -DestinationPath "${destDir}"`],
        ] as const)
      : (['unzip', ['-o', zipPath, '-d', destDir]] as const);

  await new Promise<void>((resolve, reject) => {
    const child = cp.spawn(command, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err: Error) =>
      reject(new Error(`Could not run ${command} to extract ${zipPath} (is it installed?): ${err.message}`))
    );
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code} extracting ${zipPath}: ${stderr}`))
    );
  });
}

/** An unused loopback port, chosen by the OS. */
async function freePort(): Promise<number> {
  const net = nodeRequire('node:net') as typeof netModule;
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as netModule.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Waits for the daemon to open its SOCKS port, and gives up early if it dies.
 *
 * A dead child is reported with its last log line, because "anon exited" alone
 * sends the reader looking in the wrong place — the actual reason is almost
 * always in that line.
 */
async function waitForSocksPort(
  port: number,
  timeoutMs: number,
  exited: () => boolean,
  lastLine: () => string
): Promise<void> {
  const net = nodeRequire('node:net') as typeof netModule;
  const deadline = Date.now() + timeoutMs;

  const probe = (): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
    });

  while (Date.now() < deadline) {
    if (exited()) {
      throw new Error(`anon exited before opening its SOCKS port. Last log line: ${lastLine()}`);
    }
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `anon did not open a SOCKS port on 127.0.0.1:${port} within ${timeoutMs}ms. ` +
      `Last log line: ${lastLine()}`
  );
}
