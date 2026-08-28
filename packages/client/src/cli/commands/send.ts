/**
 * `toon send [destination] …` — pay for one HTTP request and print the answer.
 *
 * The destination is optional: omitted, the request goes to the address the node
 * published for itself, so `TOON_CONNECTOR` alone is enough to buy something.
 *
 * This is what the whole client is for, and its output is shaped around one
 * distinction that is easy to get wrong.
 *
 * **A refusal is an outcome, not a crash.** The connector saying "you underpaid"
 * or "this route wants the other carriage" is a normal, informative answer: it
 * is printed in full, with what to do about it, and the process exits **3**. An
 * exception — a network that is not there, a keystore that will not open — is a
 * different kind of event and exits somewhere else entirely.
 *
 * **The status printed is the *app's*.** A `404` from the app behind the route
 * rides home on a FULFILL and costs exactly what a `200` costs, because the
 * connector charged for putting the request through, and it did. Only a refusal
 * short of the app is a refusal.
 */
import { UsageError, listOption, stringOption } from '../args.js';
import type { CommandContext } from '../context.js';
import { assetFromSettlement, decodeUtf8, formatAmount, type AssetInfo } from '../output.js';
import type { SendRefused, SendRequest, SendResult } from '../../client/types.js';

/** Split one `-H name:value` into its two halves. */
export function parseHeaderSpec(spec: string): [string, string] {
  const colon = spec.indexOf(':');
  if (colon <= 0) {
    throw new UsageError(`-H expects 'name:value'; got '${spec}'`, 'send');
  }
  return [spec.slice(0, colon).trim(), spec.slice(colon + 1).trim()];
}

/** Is a header with this name already present? Header names are case-insensitive. */
function hasHeader(headers: [string, string][], name: string): boolean {
  const wanted = name.toLowerCase();
  return headers.some(([key]) => key.toLowerCase() === wanted);
}

/**
 * Assemble the request from the flags.
 *
 * The three body forms are mutually exclusive and each one exists for a
 * different shape of caller: `--body TEXT` for a person typing, `--body-file`
 * for content that is already a file (and may be binary, which is why it is read
 * as bytes), and `--body -` for a pipeline. Exported so the parsing is tested
 * without a client.
 */
export async function buildRequest(ctx: CommandContext): Promise<SendRequest> {
  const bodyFlag = stringOption(ctx.values, 'body');
  const bodyFile = stringOption(ctx.values, 'body-file');
  if (bodyFlag !== undefined && bodyFile !== undefined) {
    throw new UsageError('give --body or --body-file, not both', 'send');
  }

  const headers = listOption(ctx.values, 'header').map(parseHeaderSpec);

  let body: string | Uint8Array | undefined;
  if (bodyFlag === '-') {
    const readStdin = ctx.deps.readStdin;
    if (readStdin === undefined) {
      throw new UsageError('--body - reads stdin, and stdin is unavailable', 'send');
    }
    body = await readStdin();
  } else if (bodyFlag !== undefined) {
    body = bodyFlag;
  } else if (bodyFile !== undefined) {
    const readFileBytes = ctx.deps.readFileBytes;
    if (readFileBytes === undefined) {
      throw new UsageError('--body-file cannot be read in this environment', 'send');
    }
    try {
      body = readFileBytes(bodyFile);
    } catch (err) {
      throw new UsageError(
        `cannot read --body-file ${bodyFile}: ${err instanceof Error ? err.message : String(err)}`,
        'send'
      );
    }
  }

  if (ctx.values['json-body'] === true) {
    if (body === undefined) throw new UsageError('--json-body needs a body', 'send');
    const text = typeof body === 'string' ? body : decodeUtf8(body);
    if (text === undefined) throw new UsageError('--json-body was given bytes that are not UTF-8', 'send');
    try {
      JSON.parse(text);
    } catch (err) {
      throw new UsageError(
        `--json-body was given something that is not JSON: ${err instanceof Error ? err.message : String(err)}`,
        'send'
      );
    }
    // The body is forwarded as the exact bytes the user supplied rather than
    // re-serialized from the parse: `--json-body` is a check and a content type,
    // not a reformatter, and an app that signs or hashes its request body would
    // not survive being helpfully re-indented.
    if (!hasHeader(headers, 'content-type')) headers.push(['content-type', 'application/json']);
  }

  const method = stringOption(ctx.values, 'method');
  const target = stringOption(ctx.values, 'target');
  return {
    ...(method !== undefined ? { method } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(headers.length > 0 ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

/**
 * What to try next, given a refusal.
 *
 * The point of this CLI's error handling: a refusal that only says `F03` has
 * told a newcomer nothing. Each hint names the command that addresses the cause.
 */
export function refusalHint(result: SendRefused, asset: AssetInfo): string[] {
  const cost =
    result.accumulatedCost === undefined ? undefined : formatAmount(result.accumulatedCost, asset);

  switch (result.code) {
    case 'PAYMENT_REQUIRED':
    case 'TRANSPORT_REQUIRED': {
      const required = result.terms?.requiredTransport;
      if (required !== undefined) {
        return [`This route only accepts the ${required} carriage. Retry with --transport ${required}.`];
      }
      return [
        'The connector answered with terms instead of doing the work, which means it saw no',
        "usable claim. Check the channel with 'toon channel status --connector-view'.",
      ];
    }
    case 'F03':
      return cost === undefined
        ? ['The claim did not advance far enough to cover the route.']
        : [
            `The route costs ${cost}. Either the claim did not advance by that much, or the`,
            'channel has no room left for it — add collateral with',
            "'toon channel deposit <base units>', then send again.",
          ];
    case 'F01':
      return [
        'The connector would not take the claim: it names a channel it cannot see, or a nonce',
        "it has already banked. Compare the two watermarks with 'toon channel status --connector-view'.",
      ];
    case 'F02':
      return [
        'No route to that destination over this carriage. Check what this node actually serves',
        "with 'toon describe', and which carriage it wants.",
      ];
    case 'F00':
      return [
        "The target path was refused before the app saw it: --target is resolved strictly beneath",
        'the route handler, so it cannot be absolute, contain `..`, or name a host.',
      ];
    case 'F06':
      return ["No claim was attached. Open a channel with 'toon channel open --deposit 100000'."];
    default:
      if (result.code.startsWith('T')) {
        return ['A temporary refusal — the path asked you to try again shortly.'];
      }
      return [];
  }
}

/** The `--json` document for one result. `raw` is dropped: it repeats what is above it. */
function payloadFor(result: SendResult): unknown {
  if (result.fulfilled) {
    const text = decodeUtf8(result.body);
    return {
      fulfilled: true,
      transport: result.transport,
      status: result.status,
      headers: result.headers,
      body: result.body,
      ...(text !== undefined ? { text } : {}),
      fulfillment: result.fulfillment,
      claim: result.claim,
    };
  }
  const { terms, ...rest } = result;
  return {
    ...rest,
    ...(terms !== undefined
      ? {
          terms: {
            destination: terms.destination,
            price: terms.price,
            httpEndpoint: terms.httpEndpoint,
            btpEndpoint: terms.btpEndpoint,
            requiredTransport: terms.requiredTransport,
            settlements: terms.settlements,
            sessionLeaseTtlMs: terms.sessionLeaseTtlMs,
          },
        }
      : {}),
  };
}

export async function run(ctx: CommandContext): Promise<number> {
  const request = await buildRequest(ctx);
  const amountFlag = stringOption(ctx.values, 'amount');

  const client = await ctx.client();
  // The destination is optional: with none, the packet goes to the address the
  // node published for itself, so a connector URL is the whole of the config.
  const destination = ctx.positionals[0] ?? client.defaultDestination;
  if (destination === undefined) {
    throw new UsageError(
      'send needs a destination, and this node published no address to default to',
      'send'
    );
  }

  const result = await client.send(
    destination,
    request,
    amountFlag === undefined ? undefined : { amount: BigInt(amountFlag) }
  );

  const description = await client.describe();
  const asset = assetFromSettlement(description.settlements[0]);

  ctx.out.render(payloadFor(result), () => {
    if (result.fulfilled) {
      ctx.out.line(`FULFILL ${String(result.status)}  (${result.transport})`);
      const claim = result.claim;
      ctx.out.rows(
        claim === undefined
          ? // A route priced at zero takes no claim, so there is no channel,
            // nonce or amount to show. Saying so beats printing zeroes.
            [['paid', 'nothing — this route is free']]
          : [
              [
                'paid',
                `${formatAmount(claim.amount, asset)}  channel ${claim.channelId} nonce ${String(claim.nonce)}`,
              ],
              ['cumulative', formatAmount(claim.cumulative, asset)],
            ]
      );
      if (result.headers.length > 0) {
        ctx.out.line();
        ctx.out.rows(result.headers.map(([k, v]): [string, string] => [`${k}:`, v]));
      }
      ctx.out.line();
      const text = decodeUtf8(result.body);
      if (text === undefined) {
        ctx.out.line(`<${String(result.body.length)} bytes of binary; use --json for base64>`);
      } else if (text.length > 0) {
        ctx.out.line(text.replace(/\n$/, ''));
      }
      return;
    }

    ctx.out.line(
      `REFUSED ${result.code}  (${result.transport}, refused by ${result.refusedBy})`
    );
    const rows: [string, string][] = [['message', result.message]];
    if (result.accumulatedCost !== undefined) {
      rows.push(['cost', formatAmount(result.accumulatedCost, asset)]);
    }
    if (result.claimAck !== undefined) {
      rows.push([
        'claim',
        result.claimAck.result === 'accepted'
          ? 'accepted'
          : `rejected (${result.claimAck.reason ?? 'no reason given'})`,
      ]);
    }
    if (result.terms !== undefined) {
      rows.push(['route price', formatAmount(result.terms.price, asset)]);
    }
    ctx.out.rows(rows);
    const hint = refusalHint(result, asset);
    if (hint.length > 0) {
      ctx.out.line();
      for (const line of hint) ctx.out.line(line);
    }
  });

  return result.fulfilled ? 0 : 3;
}
