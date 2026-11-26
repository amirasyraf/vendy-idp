# Vendy IDP reference

See the [README](README.md) to start the app. This reference covers behavior, permissions, checks,
and deployment details.

Backstage 1.56, scaffolded at the repository root with **the new frontend system**,
Node 24 (`mise.toml`) and the scaffold's vendored Yarn 4.13.0.

## Custom code

- `plugins/vm-status`: the VM entity card, the run page and the shared run helpers, only for
  `Resource` / `spec.type: vm`. All run data comes from the `vms` backend API (`runs.ts`), never from a
  browser GitHub token.
  - **Run page** `/vms/runs/<id>` (`RunView.tsx`, a `PageBlueprint`): run header (kind, VM, status,
    requester, short start time, elapsed duration, error) and compact ordered stage rows with a status
    dot, human status and duration. Retry attempts show their budget and countdown; failed/retrying
    errors stay visible. Stages that ran have one details expander with the GitHub attempt, job steps,
    earlier attempts, and `skippedBy`/`retriedBy`. **Retry** and **Skip** appear only when the API's
    `actions` allow them; Skip asks for confirmation and says the stage's work will not be applied.
    It polls every 5 seconds while the run is running and works before the VM's catalog entity exists,
    which is why VM templates link here.
  - **VM page** (`VmPage.tsx` header, `VmStatusCard.tsx` body, `VmActions.tsx`, shared poller
    `vmLive.ts`): the header shows the live state and the day-2 actions (Start/Stop, Reboot, Modify;
    ⋯ Apply OS updates, Re-apply configuration, Destroy) with confirm dialogs (Destroy asks for the VM
    name). Actions post to `POST /api/vms/runs` with a per-dialog UUID request key; Modify opens the
    `vm-modify` template prefilled with the current configuration. The body has Connect (SSH command,
    **Open terminal**, certificate; Windows VMs also **Open Remote Desktop**, **Show Password** and a
    `.rdp` file with the `ssh -L 33389:localhost:3389` command for native clients), Activity (active/failed run with retry/skip, then the last 10 runs), Configuration
    and Details (health check, instance, provenance). With no known run it falls back to `cf/status`.
    When a refresh finds the entity removed from the catalog it shows "Destroyed" and stops polling.
  - Desired compute/configuration/billing/tags come from the entity's structured `spec`. Modify
    replaces the software list, so unchecked catalog software is uninstalled.
    Tags (`cost_center`, `project_code` and custom tags, shown as one cloud tags line) are self-reported,
    not organizational billing authorization. The request form's `VmTagsEditor` field
    (`packages/app/src/VmTagsEditor.tsx`) is one key/value table with fixed, required `cost_center` and
    `project_code` rows and optional extra tags; `/api/vms/requests` rejects requests without them.
    Custom spec validation is performed by the platform `register` stage; malformed custom fields are
    rendered defensively by the card.
   - It also exports `PipelineLine` (the run's stages drawn as a transit line; skipped stages are
     non-stops; every run kind draws its own stages) and the summary hook used by Home,
     Virtual Machines and Resources. For VM entities only it supplies an `EntityHeaderLayoutBlueprint` header (name, state
    pill, favourite star, actions, team, OS/platform, size) and an `EntityContentLayoutBlueprint`
    layout that puts the VM card first.
    The stock About card is hidden for VMs through `entity-card:catalog/about` config (`$not` filter);
    other entities keep it. The custom header does not render the stock entity context menu (unregister,
    inspect) on VM pages; destroy remains the supported way to remove a VM.
- `packages/app/src/SettingsGeneral.tsx`: overrides `sub-page:user-settings/general` with only the
  profile and identity cards (the app is light-only and has no sidebar to pin).
- `packages/app/src/theme/`: the Vendy look (see `packages/app/DESIGN.md`). `cfTheme.tsx`
  replaces `theme:app/light` with a unified MUI v4/v5 theme (plain white page headers, no gradient
  banners); `global.css` sets BUI tokens, self-hosted fonts and browser surfaces. Dark mode is disabled
  with `theme:app/dark: false`.
- `packages/app/src/modules/nav/`: overrides `app/layout` to put the nav in a top bar instead of a
  sidebar, and supplies that bar through `NavContentBlueprint` (Home, Resources, Launch, Search,
  search modal, settings and the signed-in user). The stock template list (`page:scaffolder`,
  `/create`) is no longer in the bar; its routes still work.
- `packages/app/src/products/catalog.ts`: product categories, IDs, resource types, and template names
   shared by Home, Resources and Launch. The only product is **Compute → Virtual Machines**.
- `packages/app/src/launch/`: **Launch** (`/launch`) starts with product categories, then products
   whose registered Scaffolder templates are tagged `product`. At `/launch/compute/virtual-machines`,
   platform cards show provider names (vSphere is marked **Coming Soon**). The next step shows
   OS/release cards from `GET /api/vm-sizes/platforms`. `GET /api/vm-sizes/image-availability`
   checks the cloud separately; missing, unready, or unverifiable releases are disabled.
   A sole configured release is preselected only when available.
   **Continue** prefills `compute.{platform,os,imageVersion}`. Admission and the platform workflow
   validate the selected release; the workflow provisions the newest bake of that release.
   Earlier steps are linked, the form's **Change** link restores the image selection, and old
   `/launch/vm-request[/<platform>]` links redirect.
- `packages/app/src/modules/home/`: a centered `HomePageLayoutBlueprint` with a **Launch a Product**
   shortcut and a resource explorer. Product panels show counts and start collapsed. Expand a panel
   for resource links, VM platform and status, and a shortcut to the product page. Unclassified
   catalog resources have an **Other Resources** panel. Home only loads the VM summary while the
   VM panel is open and has rows.
- `packages/app/src/products/VmProductPage.tsx`: **Virtual Machines** (`/products/compute/virtual-machines`)
   has status filters, each VM's pipeline and next action (SSH certificate or run), Demo Mode and a
   shortcut to VM platform selection. Home, the product page and Resources join `GET /api/vms/summary`
   by VM name on refresh (about every 5 seconds), falling back to `cf/status`. VM visibility remains
   team-scoped (admins see every VM). Status labels name the kind
  of run (`vmRunLabel` in `plugins/vm-status/src/pipeline.tsx`, shared with the VM page): "Building ·
  <stage>", "Modifying · <stage>", "Re-applying configuration · <stage>", "Starting"/"Stopping"/
  "Rebooting", "Updating OS", "Destroying", a "· retrying" suffix while a stage waits to retry, and
  "Failed at <stage>" / "<Action> failed" / "Needs attention" on failure. Otherwise the summary's
   health check decides: "Running", "Stopped", "Instance not found" (Virtual Machines has a Stopped filter). The time shown is
  absolute and labelled: "Ready since …" from `cf/ready-at`, otherwise "Requested …".
   Virtual Machines uses the same full-width gutters as Resources.
- `plugins/cf-backend`: one backend package, registered against `auth`, `permission` and
  `scaffolder`, plus the `mock-rest` and `vms` plugins (Backstage extension points belong to separate plugin IDs).
  Implements password sign-in, the team policy, `cf:ssh:sign`, `cf:vm:dispatch` and `cf:vm:run`. The two VM
  actions only create an orchestrator run (see **VM orchestrator** below) and finish; they retry
  timeouts and server errors with the same task ID, and both endpoints are idempotent per task, so a
  retry returns the existing run rather than requesting a second VM. GitHub reads use ETag conditional
  requests so unchanged polls do not consume the token's 5,000/hour rate limit. Without demo mode, a
  failed inventory scan does not block requests; with demo mode it fails closed (quota cannot be checked).
  Scaffolder task recovery is on (`scaffolder.taskRecovery.enabled`): a task interrupted by a backend
  restart resumes after its last completed step.
- **VM orchestrator** (`plugins/cf-backend/src/orchestrator.ts`, served by the `vms` plugin in
  `vms.ts`; contract in the orchestrator repo's `CONTRACTS.md` §8.2). It owns stage order, retries
  and run state in the plugin database; GitHub Actions only executes one platform `stage.yml` stage
  per dispatch, except stages that run inside the IDP itself (today the mock ServiceNow request, the
  provision run's first stage; see `inProcess` in `vms.ts`). A 10-second worker dispatches due stages, polls their GitHub run and job steps, and
  advances the run: up to 4 attempts per stage with 30 s / 2 min / 8 min backoff, a 45-minute attempt
  deadline, and no automatic retry for permanent failures (the stage's `Validate inputs` step failed,
  `startup_failure`, a dispatch rejection other than 429 or 5xx, or an in-IDP stage's
  non-transient error). Each attempt is stored with its run key before dispatch,
  so a lost dispatch response is recovered from the run title instead of dispatching again. When a
  stage fails for good, runs with a finalizer write `cf/status: failed`; power and OS-update runs
  fail without writing it. **Retry** gives the failed stage a fresh attempt budget. **Skip** is
  limited to the `software` and `ad-join` stages of provision and reapply runs.
  Admins and members of the run's team can do either. Destroy supersedes any other active run of
  that VM; any new run supersedes a failed day-2 run. Run kinds: provision, modify, reapply, power
  (start/stop/reboot), update (OS updates), destroy. Stage lists are code, not configuration.
  Routes under `/api/vms`: `GET /runs/:id`, `GET /runs?name=`, `GET /summary`, `GET /observed/:name`,
  `POST /runs/:id/retry|skip`, `POST /runs` (day-2 runs, from the VM page and `cf:vm:run`) and
  `POST /requests` (provision admission, from `cf:vm:dispatch`). Run visibility is team-scoped like
  the catalog. `POST /runs` diffs a Modify against the entity spec and refuses (409) operations the
  fresh health check shows cannot work (for example Reboot on a stopped VM). Some actions can
  still appear while the VM is transitioning; the backend checks them on submission.
- **Browser terminal** (`plugins/cf-backend/src/terminal.ts`, `plugins/vm-status/src/VmTerminal.tsx`,
  CONTRACTS.md §8.4): `POST /api/vms/terminal` signs a fresh key with the SSH CA for 5 minutes (principal
  of the VM's team, key ID `idp-terminal:<user>`) and runs the system `ssh` as the VM's `cf/ssh-user` in a PTY (`node-pty`, built
  in the image; on macOS the prebuilt `spawn-helper` may need `chmod +x` for local runs). The xterm.js
  dialog posts keystrokes and long-polls output over plain HTTP. Two sessions per user, 15-minute idle
  and 90-second orphan timeouts, open/close logged; production only (`demoAutomation`). Windows login
  users such as `Administrator` are accepted; the session is PowerShell.
- **Browser remote desktop** (Windows VMs; `plugins/cf-backend/src/rdp.ts`,
  `plugins/vm-status/src/VmRemoteDesktop.tsx`, CONTRACTS.md §8.5): `POST /api/vms/rdp` signs a session key
  like the terminal (key ID `idp-rdp:<user>`), runs `ssh -N -L 127.0.0.1:<port>:localhost:3389` to the VM,
  and does the Guacamole handshake with the `guacd` container (`guacamole/guacd:1.6.0`, sharing the
  backstage container's network namespace, `127.0.0.1:4822`) using the VM's shared login from Secrets
  Manager `compute-factory/vm/<name>` (`security=nla`, `ignore-cert`, display-update resize). The browser
  uses guacamole-common-js 1.5.0 (npm repack; `@types/guacamole-common-js`) with a custom
  `Guacamole.Tunnel` that long-polls `GET /rdp/:id/output` and posts instructions to `/rdp/:id/input`,
  never WebSocket or streamed responses (Netskope). Unacknowledged output is capped at 8 MiB (then guacd
  is paused; unconsumed input over 4 MiB closes the session); one open or connecting session per user, 30-minute idle (frame `sync` acks do not count) and 90-second orphan
  timeouts; open/close logged. `GET /api/vms/password/:name` returns the shared login to the owning team
  and admins (logged), only when the secret's `requestId` matches the VM's `cf/request-id`.
  Windows `access` is the producer of this secret. The browser terminal and browser RDP require
  automation to be enabled.
- **Containers** (`plugins/cf-backend/src/{containers,kube}.ts`, `packages/app/src/containers/`,
  `deploy/cluster-install.sh`; vendy CONTRACTS.md §12): the `containers` backend plugin runs a second
  orchestrator instance (tables `container_runs`/`container_run_stages`, workflow `container-stage.yml`)
  whose `deploy`/`rollout`/`restart`/`undeploy` stages call the k3s API on the host with the
  `vendy-idp` service account mounted at `/kube`. `GET /api/containers/tls-ask` is unauthenticated for
   Caddy's on-demand TLS. `deploy.sh` verifies the pulled image and runs `cluster-install.sh`
   (k3s server, both cluster autoscalers, node cleanup timer) before starting the stack. The
   installer runs `deploy/azure-autoscaler-secret.cjs` from that image to read
   `AZURE_READER_SECRET_ID` with the EC2 role and pipe the Kubernetes Secret to `kubectl`;
   the certificate isn't passed through the deploy env file. Launch → Compute → Containers and the Deploy button
   on `/products/compute/containers` open the AWS/Azure platform picker. The request form receives
   the platform as `formData.container.platform` and links back to the picker to change it. Other
   pages: the container entity detail and `/containers/runs/<id>`. The detail page shares the
   compute header layout, puts the endpoint and logs under Connect, and separates Activity,
   Configuration and Details. Its header and overview share one live status/run poller.
   The run page shows the catalog
   link only when the signed-in user can read the container entity with the run's request ID.
   Provision runs check again while active, and for up to two minutes after a run that registered
   inventory finishes, to allow for catalog processing.
- **VM health check** (`plugins/cf-backend/src/observed.ts`, CONTRACTS.md §8.3): only where
  `computeFactory.demoAutomation` is on, a 30-second scheduled task (and a scan after each finished
  day-2 run) scans every platform and keeps each platform's result in memory separately (a failing
  cloud keeps its last result): state, status checks, type, public IP, request ID and team per `cf:vm`
  tag, plus `platform`. AWS: `ec2:DescribeInstances`/`DescribeInstanceStatus` for `cf:poc=true`
  instances with the host role (infra policy `observe-vms`). Azure: ARM VM list (with power state),
  public IPs and Resource Health with the Reader principal (`plugins/cf-backend/src/azure.ts`;
  credential from Secrets Manager `AZURE_READER_SECRET_ID`, `@azure/identity` certificate auth, plain
  `fetch` to ARM). Freshness and refusals use the VM's own platform (from its spec). `GET
/observed/:name` and `/summary` expose it team-scoped. Locally it is off (`enabled: false`).
- `packages/app/src/DemoModePanel.tsx`: the Virtual Machines page's Demo Mode status, per-account usage, expiry countdowns
  and admin-only global toggle with destructive confirmation. Membership in `platform-admins` controls
  access; the roster lives only in `catalog/org.yaml`.
- The Scaffolder task page is the stock one, wrapped by `packages/app/src/VmTaskRedirect.tsx`: when a
  `vm-request` or `vm-modify` task completes successfully, the browser goes straight to its
  run page (`/vms/runs/<id>`, history replaced, so Back returns to the form). It takes the run from a
  same-origin `/vms/runs/<n>` output link (or a numeric `runId` in the task's completion output; step
  outputs are not visible to the stock task API). Failed or cancelled tasks (quota, conflicts) stay on
  the task page so the error is visible; other templates are unaffected. The earlier GitHub-job stage
  view on the task page was removed with `cf:watch-workflow`.
- `packages/app/src/PasswordSignInPage.tsx`: username/password form and an in-memory
  Backstage identity API; the restored home and signals plugins remain enabled.
- `packages/app/src/taskEventPolling.ts`: the task page receives task events by **long polling**
  `GET /api/scaffolder/v2/tasks/<id>/events` (Backstage's documented alternative), not the default SSE
  `/eventstream`. TLS-inspecting corporate proxies (Netskope observed) buffer the never-ending SSE
  response, leaving the task page blank while home-page polling still works. A poll returns as soon as
  new events exist (the backend checks about every second) or with `[]` after 30 seconds. Failed polls
  retry with 1/2/5/10 s backoff and then surface "Task updates failed…" on the page; the page hook
  reconnects from the last seen event. **Revert to SSE** by deleting the `api:scaffolder` override in
  `App.tsx` and this file.
- **Platforms, images, VM sizes and instance types** (`plugins/cf-backend/src/{platforms,imageAvailability,vmSizes,azure}.ts`,
  `packages/app/src/VmComputePicker.tsx`, `plugins/vm-status/src/vmSizes.ts`), signed-in users only;
  CONTRACTS.md §10a:
  - Each platform's `terraform/platforms/<p>/{platform.json,sizes.json}` is read from the platform repo's
    `main` through the GitHub API (cached 5 minutes, last good copy kept during outages). `PLATFORMS`
    (`aws`, `azure`) is the list the IDP can read specs and health for; `COMING_SOON` adds vSphere.
  - `GET /api/vm-sizes/platforms`: label, platform support, configured releases (`os`: id, label, versions, family,
    minMemoryMiB), tag
    rules and `staticPublicIp` per platform, for Launch, the tags editor and the stop/start wording
     (Azure keeps its address; AWS gets a new one).
  - `GET /api/vm-sizes/image-availability?platform=<p>` checks each configured release when the
    image picker opens and every 20 seconds while it stays open. The newest matching AWS AMI
    must be available; the latest eligible Azure gallery version must be provisioned and
    replicated to the launch region. Unverifiable images are disabled rather than using stale
    results. New `/api/vms/requests` recheck before reserving a VM or creating a run; retries of
    already accepted requests still return the original run.
  - `GET /api/vm-sizes/sizes?platform=<p>&os=<os>` (defaults `aws`, Linux): XS-L of the OS family's map
    (Windows sizes are larger) with vCPU, memory, architecture and network, plus `family` and `minMemoryMiB`. AWS from `ec2:DescribeInstanceTypes` (cached 1 hour); Azure from the Resource SKUs API,
    with `quotaOk`. Without cloud access it returns an `error` and types without specs.
  - `GET /api/vm-sizes/instance-types?platform=<p>`: AWS every x86_64, EBS-backed type offered in the
    region (`DescribeInstanceTypeOfferings` + `DescribeInstanceTypes`, `mac*` excluded). Azure every VM
    size without a location restriction that boots the x64 Gen2 image, categorized by series letter;
    Azure has no generation flag, so every size counts as current and the toggle is hidden. `quotaOk`
    compares free family and regional vCPU quota (Compute usages, cached 5 minutes) with the size's
    vCPUs; sizes over quota are shown greyed out as "Over vCPU quota" (B-series has no quota in this
    subscription and the region allows 10 vCPUs). Cached 1 hour; the last good list is kept on errors.
   - The platform template's `ui:field: VmComputePicker` on `compute` shows the platform and versioned image chosen
    on Launch with a **Change** link (not on Modify: `ui:options.locked`), size **cards** (size,
    instance type, vCPU, memory, network, CPU) and a collapsed **Advanced** picker: category tabs with
    counts, rows grouped by family, search, family/min vCPU/min memory filters, a current-generation
    toggle (AWS) and sortable type/vCPU/memory columns. Types below the OS's `minMemoryMiB` (Windows: 4 GiB)
    are greyed out ("Needs 4 GiB memory for this OS"). It submits exactly one of `size` or
    `instanceType` and preselects `S` (the schema has no `size` default, which the form would otherwise
    re-add beside an instance type). `VmSizePicker` (cards only, on a `size` string) stays registered for
    the earlier template revision.
  - `GET /api/vm-sizes/software` and `ui:field: VmSoftwarePicker` (`packages/app/src/VmSoftwarePicker.tsx`)
    on `configuration.software`: checkboxes for the platform repo's `ansible/software-catalog.json` entries
    offered for the form's OS family (from `formContext.formData.compute`); unavailable selections are
    dropped. `/api/vms/requests` and Modify refuse other software (400; 503 when the catalog is unreadable).
  - `VmTagsEditor` ("Cloud tags") marks keys reserved by the chosen platform (`reservedTagPrefixes`) or
    containing its forbidden characters (Azure `<>%&\?/`); submit-time validation applies every
    platform's rules. The platform's `spec.py` is authoritative.
  - **Demo mode:** `/api/vms/demo/state` returns `instanceTypes`: every platform's `sizes.json` values (all OS families);
    while it is on, other types are greyed out and unselectable, and `/api/vms/requests` and Modify
    reject them (403; 503 while the size files cannot be read).
   - The product-page row, VM header and VM card show the launched type from `cf/instance-type`, else the
     requested `instanceType` ("Custom · …") or the type the size maps to now. The product-page size badge shows the
    size (`XS`…`L`) or `◆` for a custom type. The Modify form reuses `VmComputePicker`.
- `packages/app/src/ClientMonitor.tsx` (app-root element) and `clientLog.ts`:
  - **New-version banner.** The app is a single page, so a tab opened before a deploy keeps the old
    bundle. Every 60 seconds and on tab focus, the tab fetches `index.html` (served `no-store`) and
    compares its `main.<hash>.js` with the bundle it is running. On a mismatch it shows "A new version
    of Vendy is available. [Reload]". It never reloads by itself, so half-filled forms are
    safe. Disabled on the dev server, whose bundle has no hash.
  - **Browser error reporting.** Uncaught errors, unhandled rejections, exhausted task-update polling,
    identity load failures and stale bundles are POSTed to the `client-log` backend plugin, at most 30
    per page load and only once signed in.

## Logging and troubleshooting

- **Backstage** logs JSON to stdout. The access log line is written when a request _finishes_. With
  `backend.trustProxy: 1` (production), audit and client-log entries carry the real client IP.
- **Browser reports** appear as `warn` lines `Browser <kind>: <message>` with
  `type: clientEvent`, the user, client IP, user agent, page and bundle hash
  (`plugins/cf-backend/src/clientLog.ts`; signed-in users only, 8 KB body, 60 per user per minute).
- **Caddy** writes a JSON access log for every request: client IP, status, size and duration.
  `Authorization` and `Cookie` headers are redacted by Caddy.
- Orchestrator lines start with `VM run <id> <name>`: creation, every stage dispatch (with its GitHub
  run ID), failed attempts with the next retry delay, permanent failures, manual retry/skip with the
  user, and the run outcome. GitHub API failures include GitHub's message and `x-github-request-id`.
- Run and stage state is in Postgres DB `backstage_plugin_vms` (`vm_runs`, `vm_run_stages`; demo
  mode uses `demo_settings`, `demo_vms` in the same database).
- Container logs rotate at 20 MB × 5 files per service.
- From the orchestrator repo: `./poc logs [backstage|caddy|postgres|all] [since]` and
  `./poc task <task-id>` (task status plus stored events). If the task page is blank but
  `./poc task` shows events, the problem is delivery to the browser; check Caddy for that client's
  `/events` requests and `whois` its IP (corporate TLS proxies such as Netskope).
- `LOG_LEVEL=debug` in the env file raises Backstage verbosity for a deploy.
- `catalog/`: users/teams, platform locations and the `ssh-cert` template.
- `deploy/`: Caddy, Postgres, guacd (browser RDP) and the backend/frontend bundle in Docker Compose.

The default scaffolder fields, including `MyGroupsPicker`, remain intact. Search
uses the catalog collator and PG engine (in-memory fallback for local SQLite).
`app.extensions.page:home` mounts Home at `/`, rendered by the Vendy home layout. Catalog keeps its default `/catalog` route and defaults to **Resource**.
`packages/app/src/CatalogPage.tsx` overrides `page:catalog` (in `App.tsx`) with a Vendy
 page shell: a "Resources" heading and Launch button, with the stock `CatalogFilterLayout`,
the `catalog-filter` extension inputs (including `CatalogKindFilter`) and the stock `CatalogTable`
 for search, sorting and paging. Resource results include a Product column and can be filtered by Type.
 When every listed entity is a VM, the table shows State and
Pipeline (the `PipelineLine`, without labels) columns instead of System, Description and Tags;
other lists keep the stock columns. The stock page's permission-gated Create button, support
button and export button are not rendered (export was never enabled). Both `page:catalog` and
`page:catalog/entity` are overridden with `noHeader: true`, so the plugin "Catalog" header bar is
not drawn above the list or any entity page; entity pages keep their own headers.
`CatalogKindFilter.tsx` gives normal users only the Resource kind, including normalization of
non-Resource catalog filter URLs. Members of `group:default/platform-admins` retain the full kind
picker and explicit kind links. This is a catalog-list UI restriction, not an API permission change:
User/Group entities remain readable for sign-in, ownership and template team pickers. Direct entity
pages continue to use existing catalog permissions.

## Users and teams

`catalog/org.yaml` is the sole roster of users, teams and memberships; do not repeat the roster
in documentation. User names must match the password file exactly. Add groups with `kind: Group`,
`spec.type: team`, `children: []`; put their names in each user's `spec.memberOf`. Internal team IDs
are lowercase for consistent owner refs and SSH principals; display names may retain other casing.
Membership in the reserved `platform-admins` group explicitly grants global access. The password provider calls
`signInWithCatalogUser` with the username; unknown catalog users cannot sign in.
The default ownership resolver supplies the user plus their direct groups, so
the existing policy and SSH action are unchanged. GitHub is an integration only,
not a login provider. No OAuth App or OAuth environment variables are required.

### Password file and sessions

`IDP_USERS_B64` is canonical, single-line base64 of UTF-8 text, one
`username:hash` per line. It is secret backend environment, never frontend config.
Hash format: `scrypt$16384$8$1$<16-byte-salt-base64>$<32-byte-key-base64>`.
Verification uses async Node scrypt and `timingSafeEqual`; unknown users and
malformed hashes pay a dummy scrypt cost and fail with the same generic message.

`deploy/hash-password.mjs` reads a password from stdin, strips one terminal
newline (not spaces), and prints one hash. It uses only Node built-ins and the
shared password helper in this repo. For example, on a private terminal:

```sh
read -rs PASSWORD
HASH=$(printf '%s' "$PASSWORD" | node deploy/hash-password.mjs)
unset PASSWORD
# Append "username:$HASH" to your private password file, then:
IDP_USERS_B64=$(base64 < /path/to/private/users.txt | tr -d '\n')
unset HASH
```

The orchestrator's `./poc set-password` manages this file/environment for deploy.
Never commit passwords, password files, or hashes. Base64 avoids Compose `$`
interpolation; it is encoding, not encryption.

Sessions last 12 hours from login, without sliding renewal. A signed HttpOnly,
SameSite=Lax cookie restores sign-in across reloads. Cookies are Secure on HTTPS;
plain HTTP is allowed only for local development, never in production. POST login
and sign-out require a permitted Origin and an AJAX header. Access tokens live
only in memory and refresh through the cookie; passwords are never written to
browser storage. Sign out clears the cookie and returns to the form.
The cookie signing key derives from the secret user configuration: changing any
hash invalidates all existing sessions, and unchanged configuration survives a
backend restart. This is a single-instance POC, not a full account-management,
password-reset, MFA or brute-force protection service.

## Authorization and verified upstream contracts

The custom policy applies inside the portal. The public platform Git inventory and its history
are outside that boundary. The policy enables:

1. Admin claims `group:default/platform-admins`: allow everything.
2. Delete/unregister entities and create/delete locations: deny non-admins.
3. Catalog entity permissions: `(NOT (kind Resource AND spec.type vm)) OR
IS_ENTITY_OWNER(ownershipEntityRefs)`. Catalog lists, entity retrieval and
   pickers evaluate this through the catalog's permission machinery.
4. Scaffolder task read/cancel: `IS_TASK_OWNER(createdBy = userEntityRef)`.
5. Other permissions: allow. Workflow team guards remain defense in depth; repo
   writers and holders of the shared integration PAT are trusted administrators.

Source inspection against Backstage tag `v1.56.0`:

- `plugins/scaffolder-backend/src/scaffolder/actions/builtin/catalog/fetch.ts`
  passes `credentials: await ctx.getInitiatorCredentials()` to catalog lookups.
  Thus day-2 runs (`POST /api/vms/runs`) read the VM with the user's credentials, not a privileged service lookup.
- `plugins/search-backend/src/service/AuthorizedSearchEngine.ts` authorizes each
  result's resource reference when a document type's visibility permission is
  conditional. The catalog collator supplies `catalogEntityReadPermission` and
  `document.authorization.resourceRef`. Unauthorized results are removed and
  ranks rewritten; total count is omitted. This is filtering after the engine
  query, not separate per-team indexes. Other custom collators would need their
  own visibility permission/resource references.
- `plugins/scaffolder-react/src/next/hooks/useFormDataFromQuery.ts` reads JSON
  `formData` from the URL. Card links prefill `{ "vm": "resource:default/name" }`.
- Catalog `UrlReaderProcessor` calls URL reader `search`; `GithubUrlReader`
  supports globs. `catalog/locations.yaml` registers **cf-vms** exactly, plus
  the platform templates glob. **cf-vms** sets `presence: optional`: with a
  required location, an empty `vms/` fails with “no matching files found”, and a
  failed location keeps its previous children, so destroying the last VM left it
  in the catalog as `destroying`. Optional presence makes the empty glob succeed,
  so the removed VM is orphaned and deleted (`orphanStrategy: delete`).

Source inspection and fixtures are not a substitute for a live authorization check. When those
paths change, verify two-team visibility, task logs, workflow guards, and SSH on disposable VMs.

The signer obtains the initiating identity from scaffolder credentials, re-reads
that User entity from the catalog, normalizes `spec.memberOf`, and never accepts
principals or username from input. AWS SDK v3 uses its default credential chain
(EC2 instance role in deployment). It fetches the CA per request. Temp CA/key
files are mode 0600 in a private directory and always removed in `finally`.
Only public keys and issued certificates enter scaffolder task storage. Validity
is exactly 12 hours; key ID is the catalog username.

## Demo mode

Demo mode defaults **off**. On Virtual Machines, platform admins can enable/disable it without redeploying.
Enabling destroys oldest excess VMs, keeping the newest three per requesting account, and gives
existing ready/failed VMs five minutes from enable time. New VMs get five minutes from first readiness
(or terminal failure if never ready). Day-2 runs, including stop, do not extend the deadline. A fourth request is refused;
queued, provisioning, failed and destroying VMs all occupy quota until their inventory is gone.
Quotas are per original requester, not per team, and include admins.

The `vms` plugin stores settings, deadlines and reservations in its database and checks Git
inventory every 15 seconds. Cleanup creates an orchestrator destroy run (the platform `destroy` stage
and Terraform) rather than terminating EC2 directly. Failure timers start only when `finalize` records
a failure after retries, not on a transient failure that is being retried.
Disabling invalidates queued cleanup; already-started destruction cannot be undone. Re-enabling starts
fresh timers. IDP/GitHub downtime delays cleanup, and Actions queues/Terraform add time after expiry.
This is a POC cost-control convenience, not an independent hard termination guarantee.

The deployment enables `computeFactory.demoAutomation: true`. It defaults false elsewhere so local
development and the existing smoke environment can exercise real controls without launching or deleting
production VMs. Local requests are refused while automation is disabled. Production is single-instance:
do not scale the backend horizontally without replacing its admission mutex with distributed locking.

Each VM gets one cleanup destroy run per demo-mode generation; the orchestrator retries its stages.
If that run still fails, the VM shows "Cleanup stopped" and an operator retries the run from its run
page (or toggles demo mode off and on, which starts a new generation and a new run). A reservation
whose provision run ended without ever registering inventory is released; that run can no longer be
retried. Repository writers/dispatch-token holders are trusted and can dispatch `stage.yml` directly;
do not give that access to demo users. The worker still reconciles their inventory against the policy.

## Mock ServiceNow REST demo

Every provision run starts with the **ServiceNow request** stage, which runs inside the IDP (not in
GitHub Actions). It sends VM name/team/platform/OS/size, the requester's entity ref and the run's
request ID to `POST https://idp.amirasyraf.dev/mock-rest/servicenow`. Caddy rewrites that exact path
to the `mock-rest` plugin's `/api/mock-rest/servicenow` route. The receiver returns HTTP 201 with
`{number: "RITM…", status: "created", mock: true, requestId}`, and the stage shows
"RITM… created (mock ServiceNow)" on the run page. The number is deterministic for a request ID, but
the receiver is stateless: no real ticket, approval, record lookup, persistence or
provisioning-status update is implemented. Day-2 runs do not call this demo endpoint.

The endpoint accepts only Backstage service credentials from `plugin:vms`; it is not an anonymous
public webhook. The workflow token is restricted to `catalog` and `vms`, where it can only call the
read-only demo cleanup check; it still cannot call the mock receiver. No new shared secret is needed.
The client uses a backend-configured URL constrained to this IDP origin and exact mock path,
disallows redirects, and aborts after ten seconds. HTTP 5xx/429, timeouts and network errors are
retried like any stage; any other non-201 or malformed response fails the stage without retries, so
no VM is registered. No tokens or full request bodies are logged.
Local development uses `computeFactory.mockServiceNowUrl` at `http://localhost:7007/api/mock-rest/servicenow`;
production overrides it with the public HTTPS demo path.

## Local integration limits

Base catalog file locations are relative to `packages/backend`. Use a disposable login and pass
the GitHub integration token through the environment. Local SSH signing only works with
`AWS_REGION`, `SSH_CA_SECRET_ID`, and authorized AWS credentials. Azure specs and the picker
need `AZURE_READER_SECRET_ID` and permission to read that secret; without it they report Azure
as unconfigured. Running the app for normal UI work does not require either cloud identity.

## Checks

Run the [README checks](README.md#checks) one heavy job at a time. Test the same image you will
deploy. Do not include deployment in the offline checks.

`deploy/build.sh` runs the immutable dependency install, type check, Backstage bundle, and image packaging.
It prints timings to stderr and the full local Docker image ID to stdout. Backend build bundles the frontend.
The Dockerfile uses Backstage's host-build
skeleton/bundle approach and installs Linux-native production dependencies in
the arm64 image; it never copies macOS node_modules. `openssh-client` is present.
`scripts/smoke.mjs` starts temporary Backstage and Caddy containers with SQLite, a throwaway login,
and a dummy static token. It uses the catalog's `amirasyraf` and `user1` entries to check admin and
non-admin behavior. It checks readiness, catalog locations, mock REST authorization through
Caddy, demo controls, and the authenticated read API. It runs the fixture browser checks too.
Automation is off, so it doesn't exercise the orchestrator's own ServiceNow POST, real expiry,
workflow dispatch, or VM access. No AWS credentials or production config are needed.

This POC does not use unit-test scaffolding. Verification uses static checks, the platform's existing
offline workflow integration check, and focused browser smoke checks. Browser checks cover the run
page (running, retrying with countdown, failed with Retry/Skip, Skip confirmation, succeeded, earlier
attempts, API errors, polling stop/resume), the VM page's latest run, live Running/Stopped state,
day-2 action dialogs and the requests they post, Modify prefill and destroyed state, the list
summary join and fallback, the demo panel's `vms` routes, and unchanged stock task controls; fixture
data alone does not verify a real VM run. The task fixture serves `/events` as a long-poll endpoint and
fails if the page opens `/eventstream`. Against a built (hashed) frontend it also simulates a deploy
and checks that the new-version banner appears; on the dev server that check is skipped.
`scripts/workflow-ui.mjs` uses installed Google Chrome and fixture API responses to check the served
 frontend without signing in, dispatching a workflow or changing backend state. It also walks
  Home → Compute / Virtual Machines, Launch → Compute → Containers → platform → form, and
  Launch → Compute → Virtual Machines → platform → image. It checks that both request forms pair
  related fields on desktop, align the name input and owning-team picker's borders and help text,
  and stack fields on mobile without horizontal overflow. A
 multi-release AWS fixture checks selection and submitted form payload; Azure checks that two images
 (Ubuntu, Windows Server) are not preselected, live-size presentation with a quota-blocked size, Azure tag rules, and
 (switching to Windows Server 2025) software checkboxes per OS family and the 4 GiB memory minimum in the
 Advanced picker. Remote Desktop and password reveal require a separate live check with a disposable Windows VM.
Set `WORKFLOW_UI_SCREENSHOTS` to a temporary directory to capture run states, entity cards and lists
at 1440px and 390px widths during the same fixture smoke. Inspect the images, then delete the directory.
`scripts/live-check.mjs` signs in to the deployed IDP with a real POC login (from the orchestrator's
  gitignored `.poc-passwords`) and checks, read-only, the AWS and Azure container launch forms,
  the grouped Home, VM product page, both image
 pickers, form prefill, the request form's live AWS instance types and
specs, that the newest own task page receives events by long polling, and that the newest visible VM
run's page renders all its stages (read-only; it never presses Retry or Skip). Run it after every deploy:

```sh
CF_USER=user1 CF_PASSWORD="$(grep '^user1:' ../vendy/.poc-passwords | cut -d: -f2-)" \
  mise exec -- node scripts/live-check.mjs
```

## Deploy

Copy `deploy/.env.example` to a gitignored file and fill the eight keys only:

`IDP_DOMAIN`, `IDP_USERS_B64`, `GITHUB_TOKEN`,
`POSTGRES_PASSWORD`, `BACKSTAGE_TOKEN`, `AWS_REGION`, `SSH_CA_SECRET_ID`, `AZURE_READER_SECRET_ID`.

The helper takes `./deploy/deploy.sh <host> <env-file> [<image-id> | --ghcr <digest-ref> <image-id>]`.
Prefer `./poc deploy-idp` from the `vendy` checkout rather than invoking the helper directly.

If no image ID is supplied, this builds one locally for `linux/arm64`. With an ID it does not install
dependencies, bundle, or package the image again. It copies the Compose and Caddy files from the image,
ships it through a `registry:2` service on the host,
bound to `127.0.0.1:15000` there and reached through an SSH tunnel on local port 15000:
`docker push` uploads only compressed layers the host lacks (usually just the app bundle), and the
host pulls `localhost:15000/compute-factory-idp:latest`. The rollout verifies the exact pushed
manifest digest, then checks that the running container uses the pulled image ID on that host.
A fresh Caddy reads its config at startup; the script
reloads a reused running Caddy with bounded retries. The first deployment to a new host sends all
layers. Requires Docker, local Compose, and the local
`~/.ssh/id_ed25519`. It is non-interactive, uses disposable-host SSH options
without reading/writing known_hosts, and uploads `.env` with mode 0600.
The helper uploads secret-bearing configuration without checking the SSH host key. Use the
root `./poc` wrapper, which checks the running, owned EC2 instance against local state, and keep
this disposable-host setup out of production. That ownership check is not SSH host authentication.
Builds and deployments use separate local locks. A deploy and `./poc prune-idp-images` in the same
checkout share a lock. The maintenance command pauses only the registry during collection, removes
untagged registry data and dangling IDP images, and starts the registry again. Monitor disk usage and
run it explicitly as needed; avoid running another deploy from a different checkout during maintenance.
Only `./poc up` waits for cloud-init, configures DNS, and restores saved TLS storage.

For `./poc deploy-idp --gha` and `./poc up --gha`, the `build-idp.yml` workflow uses the same build
and smoke scripts on a native Linux ARM64 runner (bundled Chromium in CI). It publishes only a
smoke-tested image; `poc` reads the manifest and config digests from the exact successful run. The
server pulls the manifest digest and stages it locally in the existing registry. This supports both
classic and containerd Docker image stores, which can report different IDs for the same artifact.
Private packages require
separate read-only credentials; the portal's GitHub token is never used for GHCR. No local Docker
or image upload is involved, and a POC teardown does not delete the reusable GHCR package.

First deploy prerequisites owned by the orchestrator:

- Populate `IDP_USERS_B64` using `./poc set-password`, with usernames matching
  `catalog/org.yaml`; include only users who should be able to log in.
- Integration PAT: `vendy-platform` Contents read, Actions read/write, Commit statuses read, and
  Metadata read.
  The IDP org/cert template is read from packaged files, not via GitHub.
- DNS points directly to the host; inbound TCP 80/443 for Caddy TLS.
- EC2 role reads the scoped CA and Azure Reader secrets, and `compute-factory/vm/*` for Windows
  shared logins. The role also has EC2 describe permissions; IMDSv2 hop limit 2 lets Docker reach it.
- Infra-generated Postgres password/static token; platform workflow secret
  `BACKSTAGE_TOKEN` matches the runtime value. External access is restricted to
  the `catalog` and `vms` plugins using the current `backend.auth.externalAccess` shape.
- Health: `https://idp.amirasyraf.dev/.backstage/health/v1/readiness` returns 200
  through Caddy (paths are proxied unchanged except the exact mock ServiceNow path described above).

Postgres, Caddy and the registry use named volumes. A routine deploy preserves them; a full POC
teardown does not preserve the host's Postgres data. There is no automated database backup or
restore. Git inventory cannot reconstruct run attempts, task events, or demo settings. Do not drop
or recreate `postgres_data` as a troubleshooting step while VMs are being managed.
