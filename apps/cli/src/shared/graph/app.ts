import type { MicrosoftApp } from '../microsoft/auth';

// pim's own multi-tenant public client registration, for Microsoft Graph.
// Work or school tenants that do not let users consent to apps from
// unverified publishers need an admin to consent to it once, or their own app
// registration, set as client-id in the graph table of an account.
export const pimClientId = '161e31aa-5a5e-4f0f-a4c5-9660cf121f18';

// pim only reads calendars for now. It asks for write access already so that
// writing later needs no new consent.
const graphScope =
  'https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Calendars.ReadWrite.Shared offline_access';

export const graphApp = (clientId: string): MicrosoftApp => ({
  clientId,
  scope: graphScope,
  credential: 'graph',
});
