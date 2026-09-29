import { Layer } from 'effect';
import { MailConfig } from '../features/mail/services/config';
import { Imap } from '../features/mail/services/imap';
import { MicrosoftAuth } from '../features/mail/services/microsoft-auth';
import { Secrets } from '../features/mail/services/secrets';

// Everything a command may need. Imap connects lazily, so commands that only
// read the config never touch the network.
export const appLayer = Layer.mergeAll(
  MailConfig.Default,
  Secrets.Default,
  MicrosoftAuth.Default,
  Imap.Default,
);
