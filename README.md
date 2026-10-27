# pim

> Built on [davidvornholt/standards](https://github.com/davidvornholt/standards).

`pim` is a command-line tool for AI agents to work with a person's information. Its `mail` commands search, read, and draft email in IMAP accounts. It works with any IMAP server that accepts a password or app password, and with Outlook.com and Microsoft 365 accounts through Microsoft sign-in. It never sends mail: drafts go to the account's drafts folder, where you review and send them from your mail client.

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

`pim login` checks each login against the server before storing it in the keyring service `pim` under `mail:<email>`. On Linux this needs a running Secret Service provider such as gnome-keyring.

### Outlook and Microsoft 365

Microsoft does not accept passwords over IMAP, so these accounts need `auth = "microsoft"` and `host = "outlook.office365.com"`. `pim login` then shows a code to enter at Microsoft's sign-in page in any browser and stores the resulting refresh token instead of a password. Each command trades it for a short-lived access token, and a sign-in lasts until Microsoft revokes it or it goes 90 days unused.

pim uses Mozilla Thunderbird's public app ID, so Microsoft's consent screen asks you to allow Thunderbird. Work or school tenants can block IMAP, device code sign-in, or apps that an administrator has not approved; in that case, ask the administrator.

## Use

Run `pim --help` for the commands, `pim mail --help` for the mail commands, and `pim <command> --help` for their options. The skill in [`apps/cli/skills/pim-mail`](apps/cli/skills/pim-mail/SKILL.md) tells agents how to draft and reply.

## Develop

`bun run check` runs the standards drift check, lint, type checks, tests, and the build. It must pass before a change is done. Run the command from source with `bun apps/cli/src/app/cli.ts`.

## License

[MIT](LICENSE) © David Vornholt
