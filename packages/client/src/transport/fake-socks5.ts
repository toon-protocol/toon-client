/**
 * A minimal SOCKS5 server, for tests.
 *
 * It exists to answer one question the real network cannot answer cheaply: did
 * the *hostname* arrive at the proxy? A hidden-service address has no clearnet
 * DNS record, so if this client ever resolves one locally the request does not
 * merely fail — it leaks the address into a plaintext DNS query first. The
 * fixture records every destination it is asked for, and only knows how to reach
 * names in `routes`, so a client that resolved locally cannot accidentally pass.
 *
 * Test-only, but it lives in `src/` rather than a test file because both the
 * transport tests and the (skipped) live-HS integration test use it.
 */
import net from 'node:net';

/** A destination as it arrived at the proxy, before any resolution. */
export interface Socks5Request {
  host: string;
  port: number;
  /** `domain` when the client sent a name, `ipv4` when it sent an address. */
  kind: 'domain' | 'ipv4';
}

export interface FakeSocks5Server {
  /** `socks5h://127.0.0.1:<port>` — what a client is configured with. */
  url: string;
  port: number;
  /** Every CONNECT this proxy was asked for, in order. */
  requests: Socks5Request[];
  close(): Promise<void>;
}

/**
 * Starts a SOCKS5 proxy on loopback that can reach only the names in `routes`.
 *
 * @param routes hostname → the loopback port it stands for. A destination not
 *   in the map is refused with a SOCKS "host unreachable" reply, exactly as an
 *   `anon` daemon refuses a hidden service it cannot find.
 */
export async function startFakeSocks5(routes: Map<string, number>): Promise<FakeSocks5Server> {
  const requests: Socks5Request[] = [];

  const server = net.createServer((client) => {
    let stage: 'greeting' | 'request' | 'piping' = 'greeting';

    client.on('error', () => client.destroy());
    client.on('data', (chunk) => {
      if (stage === 'greeting') {
        // VER NMETHODS METHODS… → we only ever speak "no authentication".
        if (chunk[0] !== 0x05) return client.destroy();
        stage = 'request';
        client.write(Buffer.from([0x05, 0x00]));
        return;
      }

      if (stage !== 'request') return;
      // VER CMD RSV ATYP DST.ADDR DST.PORT
      if (chunk[0] !== 0x05 || chunk[1] !== 0x01) return refuse(client, 0x07);

      const atyp = chunk[3];
      let host: string;
      let port: number;
      let kind: 'domain' | 'ipv4';
      if (atyp === 0x03) {
        const len = chunk.readUInt8(4);
        host = chunk.subarray(5, 5 + len).toString('utf8');
        port = chunk.readUInt16BE(5 + len);
        kind = 'domain';
      } else if (atyp === 0x01) {
        host = Array.from(chunk.subarray(4, 8)).join('.');
        port = chunk.readUInt16BE(8);
        kind = 'ipv4';
      } else {
        return refuse(client, 0x08);
      }

      requests.push({ host, port, kind });
      stage = 'piping';

      const target = routes.get(host);
      if (target === undefined) return refuse(client, 0x04); // host unreachable
      const upstream = net.connect({ host: '127.0.0.1', port: target }, () => {
        // VER REP RSV ATYP BND.ADDR BND.PORT — a zeroed bind address is legal.
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    url: `socks5h://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function refuse(client: net.Socket, code: number): void {
  client.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
  client.end();
}
