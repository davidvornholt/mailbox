import { Layer } from 'effect';
import { Imap } from '../features/mail/services/imap';
import { AccountConfig } from '../shared/accounts/config';
import { Secrets } from '../shared/accounts/secrets';
import { Dav } from '../shared/dav/dav';
import { Graph } from '../shared/graph/graph';
import { MicrosoftAuth } from '../shared/microsoft/auth';

// Everything a command may need. Imap, Dav and Graph connect lazily, so
// commands that only read the config never touch the network.
export const appLayer = Layer.mergeAll(
  AccountConfig.layer,
  Secrets.layer,
  MicrosoftAuth.layer,
  Imap.layer,
  Dav.layer,
  Graph.layer,
);
