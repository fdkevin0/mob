# Runners in the cloud

**Deploy to the cloud** in the Connect a runner dialog runs Mob as a runner in
your own account at a cloud host, on its free tier, so Mob stays on without
your computer. Today the host is [Render](#render), set up in three steps. On
Render's free tier, **conversations, memory and added providers reset on
every restart or deploy**; a paid instance with a disk keeps them (see
[Keeping conversations](#keeping-conversations)).

It is the [encrypted runner](remote-access.md#encrypted-remote-runners) with
no terminal: the relay and the trust boundary are the same, and Mob still
listens only on loopback inside its container. Every host builds the same
`Dockerfile` and reads the pairing JSON from `MOB_RUNNER_PAIRING`.

## Render

1. Pick Render and choose **Create cloud pairing**. It registers a runner and
   shows its pairing JSON: the URL, runner ID, encryption key and the runner
   credential itself
   (`POST /api/runners` with `{"for":"deploy"}`). There is no one-time code,
   because a free instance loses its files on every restart and could not keep
   what it claimed. The cloud stores only the credential's hash.
2. **Deploy to Render** opens `render.com/deploy` for this repository. Render
   reads the Blueprint `render.yaml` and asks for `MOB_RUNNER_PAIRING`; paste
   the pairing JSON there.
3. Render builds `Dockerfile` and starts `mob runner --serve`. When the runner
   shows online in the dialog, choose **Open runner**.

The Blueprint is one free web service. Render may restart a free instance at
any time and its files do not survive that, so **conversations, memory and
added providers reset on every restart or deploy**; the runner reconnects by
itself from `MOB_RUNNER_PAIRING`. A free instance also sleeps after 15 minutes
without inbound requests. The runner's relay connection is outbound and does
not count, so the image passes `--keep-awake` with Render's
`RENDER_EXTERNAL_URL`: the runner requests its own public address every 10
minutes. One always-on instance uses about 744 of the workspace's 750 free
hours a month. Deploys are manual (`autoDeployTrigger: off`), so a merge to
`main` never interrupts a turn; use **Manual Deploy** in Render to update.

### Keeping conversations

To keep conversations, upgrade the same service (about $7 a month plus $0.25
for the disk, billed by Render):

1. On the Blueprint's **Settings** page in Render, set **Auto Sync** to No, so
   a later change to `render.yaml` does not switch the plan back to free.
2. On the service, change the instance type to Starter and add a 1 GB disk
   mounted at `/data`. `HOME` is `/data`, so configuration, `providers.json`
   and the database then survive restarts.

### Details

- `mob runner --serve` starts Mob in the same process and exits when either
  stops, so the host restarts both together. `--health-addr` answers every
  request with `ok` for the host's health check and serves nothing else.
- With `MOB_RUNNER_PAIRING` set, `mob runner` uses those credentials instead
  of `runner.json`. The variable holds the encryption key and the credential,
  so it belongs in the host's secret settings. To pair again, revoke the
  runner, create a new Render pairing, replace the variable and restart.
- With no `providers.json`, the runner uses the default free model, and on a
  free instance that is the only provider for now: Render's free services
  have no Shell or SSH access, and keys are not read from the environment.
  On a paid instance with a disk, add providers from Render's **Shell** with
  `mob provider add … --key-stdin`; they are kept on the disk.
- There is no container runtime on Render, so the sandbox stays off.
- The model provider sees conversations, as on a computer, and so does
  Render, which runs the runner and holds its files and the pairing JSON.

## Other hosts

| Host | Free tier | Conversations | One-click |
| --- | --- | --- | --- |
| Render | Web service, 750 hours a month, no card; sleeps without inbound requests, which the runner prevents | Reset on every restart; a paid instance with a disk keeps them | `render.yaml` Blueprint |

Hosts checked on 2026-10-20 and left out: Koyeb (new accounts need a $29 plan
since the Mistral acquisition), Fly.io (no free allowance), Hugging Face
Spaces (Docker Spaces on free hardware need PRO since July 2026), ClawCloud
Run (shutting down), Google Cloud Run (scales to zero and needs billing, so
an always-on runner costs money). Railway and Northflank are candidates
(below). The dialog lists the hosts in
`packages/app/src/hosts.ts`; it shows a host picker once there is more than
one.

### Candidate hosts

Both have a free tier that suits a runner, but their one-click links come
from a template made in the maintainer's own account, so they are not in the
dialog yet.

- **Railway**: $1 of usage a month, 0.5 GB RAM and a 0.5 GB volume, so
  conversations would be kept. A template is made once in the dashboard
  (GitHub source `fdkevin0/mob`, an empty `MOB_RUNNER_PAIRING`, a volume at
  `/data`); there is no documented API for creating or editing templates.
  After that, code updates need no work here: a `railway.json` would carry
  the build and health-check settings, and Railway tells users who deployed
  a GitHub-based template when its root branch changes, and they choose when
  to apply it. Changing the template's variables or volume stays manual.
- **Northflank**: two always-on Sandbox services; it verifies a card at
  sign-up, and free volumes are unconfirmed. Its template is JSON
  (`apiVersion`, a `Workflow` of `Project`, `CombinedService` and
  `SecretGroup` nodes, arguments for `MOB_RUNNER_PAIRING`) that can sync
  both ways with a file in this repository, so the template's
  configuration would be reviewed and updated through pull requests. Linking
  that sync and copying the share link are a one-time step in the
  maintainer's account.
