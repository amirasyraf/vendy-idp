# Vendy IDP

This is the Backstage app at [idp.amirasyraf.dev](https://idp.amirasyraf.dev). From the portal you can
launch an Ubuntu or Windows VM on AWS or Azure, follow the provisioning run, and connect once it
is ready, deploy containers, or create a private **Storage → Bucket** on S3 or Azure Blob Storage.
Each bucket has a browser file manager and temporary credentials for local uploads. Vendy uses
its own password sign-in. It does not need a GitHub OAuth app.

## Run it locally

From this checkout, install the pinned Node version and dependencies:

```sh
mise trust
mise install
mise exec -- node .yarn/releases/yarn-4.13.0.cjs install --immutable
```

Set `IDP_USERS_B64` using a [throwaway local login](REFERENCE.md#password-file-and-sessions) and set
`GITHUB_TOKEN` in your shell so Backstage can read the platform repo. The username must exist in
[`catalog/org.yaml`](catalog/org.yaml).

```sh
NODE_OPTIONS=--no-node-snapshot mise exec -- node .yarn/releases/yarn-4.13.0.cjs start
```

Open [localhost:3000](http://localhost:3000). The local catalog uses in-memory SQLite. VM automation
is off by default, and Bucket operations require the deployed storage infrastructure. Use the local server to work on UI
changes without rebuilding the Docker image.

## Checks

```sh
mise exec -- node .yarn/releases/yarn-4.13.0.cjs lint
image="$(./deploy/build.sh)"
IDP_IMAGE="$image" mise exec -- node scripts/smoke.mjs
```

The build type-checks and packages a Linux ARM64 image. The smoke check uses `GITHUB_TOKEN` from your
shell and runs the image locally with a temporary login. It checks catalog loading, API access, and
selected flows in Chrome. It does not create a VM. See the [check coverage and live-check
instructions](REFERENCE.md#checks) for what the fixtures do and don't prove.

## Deploy

From the sibling `vendy` checkout, run `./poc deploy-idp "$image"` to ship the tested image to an
existing POC host, or `./poc deploy-idp --gha` to build pushed `main` in GitHub Actions and pull the
tested image directly on the host. `./poc up [--gha]` handles first-time host setup and DNS. Run the
[signed-in check](REFERENCE.md#checks) after deploying. Don't rebuild or tear down the environment
just to ship an app change.

## Where to look

| Looking for | Start here |
|---|---|
| Launch, Home, design, or theming | [`packages/app`](packages/app), [design notes](packages/app/DESIGN.md) |
| VM pages and run progress | [`plugins/vm-status`](plugins/vm-status) |
| Sign-in, VM and container orchestration, or cloud integrations | [`plugins/cf-backend`](plugins/cf-backend) |
| Users, teams, and catalog sources | [`catalog`](catalog), [authorization reference](REFERENCE.md#authorization-and-verified-upstream-contracts) |
| Troubleshooting a task, run, or proxy issue | [Logging and troubleshooting](REFERENCE.md#logging-and-troubleshooting) |
