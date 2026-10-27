import { Layer } from 'effect';
import { Imap } from '../features/mail/services/imap';
import { MicrosoftAuth } from '../features/mail/services/microsoft-auth';
import { AccountConfig } from '../shared/accounts/config';
import { Secrets } from '../shared/accounts/secrets';
import { Dav } from '../shared/dav/dav';

// Everything a command may need. Imap and Dav connect lazily, so commands that
// only read the config never touch the network.
export const appLayer = Layer.mergeAll(
  AccountConfig.layer,
  Secrets.layer,
  MicrosoftAuth.layer,
  Imap.layer,
  Dav.layer,
);
