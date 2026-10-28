# pim

> Built on [davidvornholt/standards](https://github.com/davidvornholt/standards).

`pim` is a command-line tool for AI agents to work with a person's information. Its `mail` commands search, read, and draft email in IMAP accounts. It works with any IMAP server that accepts a password or app password, and with Outlook.com and Microsoft 365 accounts through Microsoft sign-in. They never send mail: drafts go to the account's drafts folder, where you review and send them from your mail client. Its `calendar` commands read calendars over CalDAV and create, change, and delete events. They invite attendees, and change or cancel meetings the user organizes, only with `--notify-attendees`; the calendar server then emails the attendees, and pim refuses servers that do not. Its `contacts` commands read address books over CardDAV and create, change, and delete contacts.

## Install

```bash
bun install
just install
```

This builds a standalone binary to `~/.local/bin/pim` and installs the agent skills from [`apps/cli/skills`](apps/cli/skills) to `~/.agents/skills`, where Codex and Claude Code find them. Run it again after pulling changes.

## Configure

Copy [`apps/cli/accounts.example.toml`](apps/cli/accounts.example.toml) to `~/.config/pim/accounts.toml` (or set `PIM_CONFIG`) and add one `[[accounts]]` block per account. Then log in to each account and check that it works:

```bash
pim login
pim status
```

`pim login` checks each login against the server before storing it in the keyring service `pim` under `mail:<email>`, and the calendar and contacts login under `dav:<email>`. On Linux this needs a running Secret Service provider such as gnome-keyring.

### Calendars and contacts

An account gets calendars and contacts from an `[accounts.dav]` table with the server's DAV root URL, such as `https://sync.infomaniak.com/` for Infomaniak. pim finds the calendars and address books from there. `user` defaults to the IMAP user; some providers, Infomaniak among them, use a separate DAV username and app password. `pim login --account <email> --only dav` logs in to calendars and contacts alone.

### Outlook and Microsoft 365

Microsoft does not accept passwords over IMAP, so these accounts need `auth = "microsoft"` and `host = "outlook.office365.com"`. `pim login` then shows a code to enter at Microsoft's sign-in page in any browser and stores the resulting refresh token instead of a password. Each command trades it for a short-lived access token, and a sign-in lasts until Microsoft revokes it or it goes 90 days unused.

pim uses Mozilla Thunderbird's public app ID, so Microsoft's consent screen asks you to allow Thunderbird. Work or school tenants can block IMAP, device code sign-in, or apps that an administrator has not approved; in that case, ask the administrator.

## Use

Run `pim --help` for the commands, `pim mail --help`, `pim calendar --help`, or `pim contacts --help` for a group, and `pim <command> --help` for their options. The skills in [`apps/cli/skills`](apps/cli/skills) tell agents how to use each group.

## Develop

`bun run check` runs the standards drift check, lint, type checks, tests, and the build. It must pass before a change is done. Run the command from source with `bun apps/cli/src/app/cli.ts`.

## License

[MIT](LICENSE) © David Vornholt
