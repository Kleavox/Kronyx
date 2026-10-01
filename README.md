# Krynodes

Krynodes is a small, self-hosted monitoring console on Cloudflare Workers. A Go
agent on each server reports metrics and runs HTTP, TCP and systemd checks; the
Worker stores history in D1, opens and resolves incidents, and mails the
operator. The dashboard sits behind Cloudflare Zero Trust; one login can be
shared by a small team, and every open tab sees what the others do as it
happens.

```text
Browser ── Cloudflare Access ── kry Worker ── D1
                                     ▲    │
                      kry (agent) ┘    └── send_email → operator
```

## Layout

| Path                | What                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `worker/`           | Hono Worker: dashboard API, agent API, D1 migrations, daily retention cron; the `stats` Worker in `src/stats/` |
| `app/`              | React dashboard (Tailwind v4, shadcn/ui, Recharts, TanStack Query)                                             |
| `agent/`            | Go agent: metrics, checks, enrollment, systemd install                                                         |
| `packages/protocol` | Zod schemas for the agent ↔ Worker contract, with a fixture the Go tests read too                              |
| `tooling/`          | TypeScript presets, Vite config, lint scripts                                                                  |

## Develop

```sh
pnpm install
pnpm turbo run build --filter=@krynodes/worker^...
pnpm exec wrangler dev --config worker/wrangler.jsonc --port 8790
```

With no Access variables set, the Worker runs as a local standalone operator,
so the dashboard opens without signing in. Production refuses to serve at all
without Access (see below). Emails are simulated locally and written under
`worker/.wrangler/tmp/email/`.

Rebuild the app and restart `wrangler dev` after every app change; it serves the
built assets from `app/dist`.

## Check

```sh
pnpm check         # format, knip, lint scripts, typecheck, tests, build
pnpm native:check  # go test, vet, build, deadcode
```

CI (`.github/workflows/ci.yml`) runs the same steps on every push to `main`, then
its `deploy` job ships the Worker to `kry.kleavox.xyz` when the app or Worker
changed. **Run workflow** on the Validate workflow deploys by hand.

## Production

- **Access.** Put the dashboard hostname behind a Cloudflare Access application.
  The Worker verifies the Access token itself and answers 401 without one.
- **Agents** report to the Worker's `workers.dev` address (`AGENT_ORIGIN`),
  outside the zone, so zone bot protection cannot challenge them.
- **Configuration.** `env.production` in `worker/wrangler.jsonc` holds the
  public values. The GitHub environment `production` supplies the rest:
  secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `KRY_D1_ID`,
  `ALERT_EMAIL`, and variables `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`.
- **Bindings.** D1 `DB`, `send_email` `EMAIL` (the operator's address verified
  in Email Routing), static assets `ASSETS`.

## Agent

The agent is a single binary, `kry`. **Enroll node** in the dashboard gives one
command to paste on the server:

```sh
curl -fsSL https://<agent-host>/install.sh | sudo sh -s -- https://<agent-host> <token>
```

It downloads the latest release for the server's architecture, checks its
SHA-256, installs `/usr/local/bin/kry`, enrolls the node, and starts the
`krynodes` systemd service (config in `/etc/kry/config.json`). The node takes
the server's hostname as its name (**Rename node** changes it) and reports every
minute. The script is
`app/public/install.sh`, served as a static asset. Afterwards:

```sh
sudo systemctl status krynodes
sudo kry status
```

Releases are cut by `.github/workflows/agent-release.yml` whenever
`agent/VERSION` changes on `main`, as `agent-v<version>` with `krynodes-linux-amd64`
and `krynodes-linux-arm64`, their checksums, ed25519 signatures and build
provenance. The workflow signs with the repository secret `AGENT_SIGNING_KEY`
and refuses to publish if it does not match `agent/internal/update/release.pub`.

### Checks

Checks run on the agent of the server they belong to: HTTP (down on errors,
timeouts and 5xx answers), TCP (down when the connection fails) and systemd
(up while the unit is active). A check's menu on the Checks page or the node
page has **Edit** (name, server, kind, target, timeout), **Pause** / **Resume**,
**Status page** and **Remove**, which asks first. Changing what is checked (kind,
target or server) or pausing starts the status fresh and closes an open
incident; the history stays. A server with a live connection (below) runs the
changed check within seconds; others at their next report.

Removing a check, pausing it or changing its kind, target or server asks for
a core device's fingerprint (see Deploy), like deleting a server or creating
an install command. One fingerprint covers 15 minutes of such work. An owner
with no trusted device yet is not asked.

Incident mail is grouped: the Worker waits 90 seconds and sends one mail per
server ("pivox: 2 checks down — Health, API", "pivox: check back up — API"); a
check that goes down and comes back inside the wait is left out. At most 6
incident mails go out an hour; what comes after waits for one summary mail.
While an action runs on a server and for 2 minutes after it (10 minutes after
a restart, until the agent is back), failing checks there open no incident and
their bars read "maintenance"; a check still failing afterwards opens one at
its next failure. Actions and deploys never mail.

### Live connection

Each server keeps one WebSocket open to the Worker (`/api/agent/stream`), held
by a Durable Object (`FleetHub`, one per owner, SQLite class, Free plan). From
agent 0.3.1 everything travels over it: reports, config and action results.
The dashboard can wake a server at once: queued actions, check changes, update
and refresh requests, and applied trust changes reach it in seconds instead of
up to a minute.

- History is one D1 row per server per 5-minute window (`node_windows`), with
  the averaged metrics and every check's result; the hub writes it when the
  window ends or the connection closes. Failures keep their message.
- The server row is written when the connection opens, once per window and
  when it closes; between those the dashboard asks the hub, so a server still
  shows offline after about 3 minutes of silence.
- There is no HTTP fallback. The agent sends a `ping` every 25 seconds, drops
  a connection that stays silent for 75 seconds and reconnects after 1 second,
  doubling to 1 minute (with jitter). Cloudflare closes every connection on a
  deploy or restart; agents are back within seconds and report at once.
- Agents before 0.3.1 are not supported. The live connection refuses them
  (426) and the old HTTP report routes answer 410 `AGENT_UPDATE_REQUIRED`; the
  node page shows the command to update such a server by hand.
- At a 60-second interval a server costs about 870 D1 writes a day on a live
  connection and about 2,000 on HTTP (was about 4,900).

Dashboards use the same hub: each tab opens `GET /api/live`, a WebSocket that
only says what changed (servers, checks, actions, services). The tab then
refetches those lists, so when one person restarts a service everybody's
screen shows it within a second or two. Tabs keep their usual polling as the
fallback and reconnect on their own.

### Usage and quota shares

The fleet page's **Krynodes quota** tile opens **Usage today**: Krynodes'
requests, D1 writes and D1 reads against its share of the account's free
quotas (editable there; other projects may share the account), and the whole
account against the Free plan. Quotas reset at 00:00 UTC.

Without setup the numbers are estimates. For Cloudflare's real counts, create
an API token with one permission (Account, Account Analytics, Read) and save it
as the GitHub production secret `CF_ANALYTICS_TOKEN`; the next deploy hands it
to the Worker together with the account and database ids it already has. The
Worker asks Cloudflare at most every 15 minutes while someone looks.

### Updating the agent

The Worker checks GitHub for the latest `agent-v*` release once a day (or on
**Check now**); agents never poll GitHub. Each server shows its agent version,
with an arrow when it is behind, and the **Updates** filter lists them.

- **Update agent** (node detail) or **Update N** (Fleet) asks the agent to update
  on its next report. The agent drops the request in
  `/var/lib/kry/update-request`; the root unit `krynodes-update.path` starts
  `kry self-update`, which downloads the release from this repository, checks
  the SHA-256 and the signature against the key built into the agent, refuses
  downgrades, keeps the old binary as `kry.previous` and restarts.
- From agent 0.3.1 the download suits slow links: it fetches the gzip asset
  (about 2.6 MB instead of 6.5 MB), gives up on an attempt only after a minute
  without data, resumes where it stopped, and tries five times. The new binary
  must print its version before it is installed, and if the agent does not stay
  up after the restart the old binary comes back. Why an attempt failed shows
  on the node page.
- A stalled update is asked for again after 15 minutes, three attempts in all,
  before the dashboard calls it failed. Releases are published only once every
  file is uploaded.
- **Update automatically** (per node) requests every new release as soon as the
  Worker sees it.
- **By hand**, on the server:

```sh
curl -fsSL https://<agent-host>/install.sh | sudo sh -s -- --update
```

### Service actions

The dashboard's **Services** page lists each server's systemd units and Docker
containers, grouped by server, and starts, stops or restarts them. The node
page and Ctrl K offer the same actions, and a SERVICE check's menu has
**Restart service**. From agent 0.2.1 every one of them needs a fingerprint,
like a deploy (see below): a server that trusts no device refuses them.

From agent 0.2.2 the node page's **Actions** menu (and Ctrl K) also has
**Restart server**: after a confirmation and the same fingerprint, `kry exec`
reports "restarting the server" and then runs `systemctl reboot --no-block`.
Each server on the Services page carries the same menu.

Everything in flight is visible to everyone: the server reads
"Restarting · owner · 1:12" on every page until its agent reports again, its
services wait with their buttons hidden, a service being restarted shows who
asked and for how long, and the **Activity** button in the top bar lists what
runs now and what finished in the last hour. There are no pop-up toasts for
other people's work.

From agent 0.3.3 a service's or stack's menu has **Logs**: the last 300 lines
(`journalctl -u`, `docker logs`, `docker compose logs`), at most 64 KiB, signed
like any action and allowed for protected units because it only reads.

The agent never runs anything itself:

- It drops each request in `/var/lib/kry/actions`.
- The root oneshot `kry exec` does the work. The units `krynodes-exec.path` and
  `krynodes-exec.timer` start it, the timer every 5 minutes to refresh the list of
  services.
- `kry exec` refuses anything but a signed start, stop, restart or log read of
  a service that is present on the server.
- It never starts, stops or restarts ssh, the network, Docker itself, systemd
  internals, cloudflared or Krynodes; it only reads their logs.
- It keeps its state in `/var/lib/kry-exec`.

`kry uninstall-service` removes these units and that directory.

### Deploy

From agent 0.2.0 the **Stacks** view of the Services page deploys Docker
Compose stacks: `docker compose pull`, then `up -d`, in the stack's own
directory, with its own compose files. A failed deploy keeps the images that
ran before it, and **Roll back** starts them again.

Deploys, like start, stop and restart, need a fingerprint. On **Trusted
devices** (account menu) you register a passkey on your laptop or phone; each
server keeps the public keys in `/var/lib/kry-exec/trust.json`, and the root
executor checks every action against them, so nothing on Cloudflare can run one
on its own. One fingerprint opens a 15-minute session, like sudo: nothing on
screen counts it down, a tab hidden for 2 minutes ends it, and **Lock actions**
in the account menu ends it at once.

From agent 0.3.0 one admin login can be shared safely by several people:

- **Core devices** are the passkeys every server knows. Only they approve
  changes. **Access** is the core devices that may run actions on one server.
- The first device trusts itself on your servers (**Trust on servers**). The
  second one, such as your phone, is approved by the first alone and gets
  access to every server enrolled then.
- From then on a new core device, removing one and **Require fingerprint**
  need approvals from two core devices. A device registered by someone else
  stays inert until then, and you get an email.
- Giving a device access to a server needs one core device that already has
  access there (never the device itself), or two other core devices. Servers
  enrolled later start with the core and no access.
- Changes wait under **Waiting for approval** for up to 24 hours. Each approval
  signs the exact change; the dialog shows new devices' key fingerprints for
  you to compare with the new device's screen.
- **Require fingerprint** (agent 0.3.1) makes every server accept only
  passkeys that verify you: a fingerprint, a face or a security key. A passkey
  that only takes a touch (such as Microsoft Password Manager) leaves the core
  in the same change, and every device that stays approves it with a
  fingerprint, so you cannot lock yourself out. It cannot be turned off from
  the dashboard.
- On a computer without a fingerprint reader, choose **Use a phone** in the
  passkey window: the phone's own passkey signs, so the phone is the trusted
  device. It joins as "Phone"; a security key joins as "Security key".
- WebAuthn only reports that the person was verified, not how, so a security
  key's PIN counts the same as a fingerprint.
- Keep two fingerprint devices or more: with one, losing it needs SSH to
  recover.

To start over on a server:

```sh
sudo kry trust --reset
```

## Status page

A second Worker, `stats` (`worker/wrangler.stats.jsonc`), serves a public page at
`stats.kleavox.xyz` from the same D1 database. It lists only the checks turned
on under **Status page** in a check's menu: name, optional public note, current
state, 90 days of incident-based uptime, and recent incidents. It never shows a
check's kind, target, server or error messages. The page is plain HTML, cached
for 10 minutes and rate limited per IP. CI deploys it after the dashboard.

## Why there is no ESLint

`typescript-eslint` does not load against TypeScript 7, so no parser-based rule
can run here. `tooling/lint/unhandled-async.mjs` stands in for
`no-floating-promises` and `no-misused-promises` until it does.
