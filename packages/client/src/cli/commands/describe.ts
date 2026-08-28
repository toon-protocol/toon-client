/**
 * `toon describe [URL]` — read a connector's self-description.
 *
 * The first command anyone should run against an unfamiliar node, and the only
 * one that costs nothing and proves nothing: one unauthenticated `GET` returns
 * every fact needed to transact — the addresses it answers to, the endpoints and
 * carriages it offers, the key a payload is sealed to, what it settles in, and
 * what each route costs. There is no discovery to do beyond this.
 *
 * Runs with no keystore and no channel. A URL given here outranks `--connector`
 * and the environment, because it was typed for this one invocation.
 */
import type { CommandContext } from '../context.js';
import { assetFromSettlement, formatAmount } from '../output.js';

export async function run(ctx: CommandContext): Promise<number> {
  const url = ctx.positionals[0];
  const client = await ctx.client({
    keyless: true,
    ...(url !== undefined ? { connector: url } : {}),
  });
  const description = await client.describe();
  const asset = assetFromSettlement(description.settlements[0]);

  const payload = {
    connector: client.connector,
    ilpAddresses: description.ilpAddresses,
    httpEndpoint: description.httpEndpoint,
    btpEndpoint: description.btpEndpoint,
    peerCarriages: description.peerCarriages,
    edgeIdentity: description.edgeIdentity,
    settlements: description.settlements,
    routes: description.routes,
    requiredTransport: description.requiredTransport,
    supportedVersions: description.supportedVersions,
    defaultVersion: description.defaultVersion,
  };

  ctx.out.render(payload, () => {
    const head: [string, string][] = [['connector', client.connector]];
    if (description.ilpAddresses.length > 0) {
      head.push(['addresses', description.ilpAddresses.join(', ')]);
    }
    if (description.httpEndpoint !== undefined) head.push(['http', description.httpEndpoint]);
    if (description.btpEndpoint !== undefined) head.push(['btp', description.btpEndpoint]);
    if (description.requiredTransport !== undefined) {
      head.push(['requires', `${description.requiredTransport} carriage`]);
    }
    if (description.edgeIdentity !== undefined) {
      head.push([
        'seals to',
        `${description.edgeIdentity.publicKey}${
          description.edgeIdentity.keyId === '' ? '' : ` (key ${description.edgeIdentity.keyId})`
        }`,
      ]);
    }
    head.push([
      'versions',
      `${description.supportedVersions.join(', ')} (default ${String(description.defaultVersion)})`,
    ]);
    ctx.out.rows(head);

    ctx.out.line();
    if (description.settlements.length === 0) {
      ctx.out.line('Settlements: none — this node cannot be paid.');
    } else {
      ctx.out.line('Settlements:');
      ctx.out.rows(
        description.settlements.map((s): [string, string] => [
          s.chain,
          [
            `counterparty ${s.settlementAddress}`,
            `token ${s.tokenAddress} (${String(s.decimals)}dp)`,
            s.kind === 'evm' ? `tokenNetwork ${s.tokenNetwork}` : `program ${s.programId}`,
          ].join('  '),
        ])
      );
    }

    ctx.out.line();
    if (description.routes.length === 0) {
      ctx.out.line('Routes: none published.');
    } else {
      ctx.out.line('Routes:');
      ctx.out.rows(
        description.routes.map((r): [string, string] => [r.prefix, formatAmount(r.price, asset)])
      );
    }
  });

  return 0;
}
