/**
 * NIP-90 jobs: the apps behind a connector that take a signed, kind-tagged
 * event rather than a plain HTTP body.
 *
 * This is still just {@link import('../client/types.js').ToonClientLike.send} —
 * one paid POST, one FULFILL — with the event as its body and the receipt as
 * the answer. What lives here is the shape of that body, the decoding of that
 * answer, and one multi-step ceremony that spans two nodes: buying an ArNS name
 * with no SOL, in `./ant-spawn.js`.
 */

export {
  buildJobEvent,
  jobEventParam,
  type JobEvent,
  type JobEventParams,
} from './job-event.js';

export {
  sendJob,
  type JobAnswer,
  type JobEndpoint,
  type JobSender,
} from './send-job.js';

export {
  isGasStationFailure,
  type ArnsAntPrepareReceipt,
  type ArnsBuyReceipt,
  type ArnsNameType,
  type ArnsNetwork,
  type GasStationExecuteReceipt,
  type GasStationFailureReason,
  type GasStationFailureReceipt,
  type GasStationQuoteReceipt,
  type GasStationReceipt,
  type SolanaNetwork,
} from './receipts.js';

export {
  ARNS_KIND,
  SOLANA_GAS_KIND,
  buyArnsName,
  buyArnsNameWithNewAnt,
  spawnAnt,
  type AntSpawnOutcome,
  type AntSpawnParams,
  type AntSpawnRefused,
  type AntSpawnStep,
  type AntSpawned,
  type ArnsBuyOutcome,
  type ArnsBuyParams,
  type ArnsNameWithAntOutcome,
} from './ant-spawn.js';
