# Krynodes

Krynodes is a small, self-hosted monitoring console on Cloudflare Workers. A Go
agent on each server reports metrics and runs HTTP, TCP and systemd checks; the
Worker stores history in D1, opens and resolves incidents, and mails the
operator. The dashboard is for one operator and sits behind Cloudflare Zero
Trust.

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

The agent never runs anything itself:

- It drops each request in `/var/lib/kry/actions`.
- The root oneshot `kry exec` does the work. The units `krynodes-exec.path` and
  `krynodes-exec.timer` start it, the timer every 5 minutes to refresh the list of
  services.
- `kry exec` refuses anything but a signed start, stop or restart of a service
  that is present on the server.
- It never touches ssh, the network, Docker itself, systemd internals, cloudflared
  or Krynodes.
- It keeps its state in `/var/lib/kry-exec`.

`kry uninstall-service` removes these units and that directory.

### Deploy

From agent 0.2.0 the **Stacks** view of the Services page deploys Docker
Compose stacks: `docker compose pull`, then `up -d`, in the stack's own
directory, with its own compose files. A failed deploy keeps the images that
ran before it, and **Roll back** starts them again.

Deploys, like start, stop and restart, need a fingerprint. On **Trusted
devices** (account menu) you register a passkey on your laptop or phone; each
server keeps its public key in `/var/lib/kry-exec/trust.json`, and the root
executor checks every action against it, so nothing on Cloudflare can run one
on its own. One fingerprint opens a 15-minute session, like sudo: nothing on
screen counts it down, a tab hidden for 2 minutes ends it, and **Lock actions**
in the account menu ends it at once.

- New servers trust your devices through the enroll command.
- Servers enrolled earlier: **Trust on servers** on the Trusted devices page,
  accepted only while a server trusts no device yet.
- Every change to the trusted devices shows each device's key fingerprint for
  you to check before it is sent.
- Adding or removing a device needs a fingerprint from a device the servers
  already trust. To start over on a server:

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
