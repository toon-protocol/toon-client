import type { ToonClient } from '@toon-protocol/client';
import type { ToonClientLike } from './client-runner.js';

/**
 * Compile-time guard: the real {@link ToonClient} MUST satisfy the full
 * {@link ToonClientLike} control surface the daemon depends on.
 *
 * The daemon reaches the client through this interface across an
 * `as unknown as` cast at the apex boundary, so plain assignment can't catch a
 * method that was added to ToonClientLike (or to ChannelManager and surfaced as
 * a passthrough) but forgotten on ToonClient. That gap shipped once and 500'd
 * `GET /channels` with `apex.client.getSettleableAt is not a function`, which
 * rendered the wallet as "No channels open yet". If you add a REQUIRED method to
 * ToonClientLike, this assignment fails to compile until ToonClient implements
 * it. (This file is type-only — tree-shaken out of the bundle.)
 */
declare const _toonClient: ToonClient;
const _assertToonClientSatisfiesToonClientLike: ToonClientLike = _toonClient;
void _assertToonClientSatisfiesToonClientLike;
