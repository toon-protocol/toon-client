/** Every network's stored form, as the client hands them to its channel manager. */
import { evmStoredForm } from './evm-network.js';
import { solanaStoredForm } from './solana-network.js';
import type { ChannelStoredForm } from './settlement-network.js';

export const STORED_FORMS: readonly ChannelStoredForm[] = [
  evmStoredForm,
  solanaStoredForm,
];
