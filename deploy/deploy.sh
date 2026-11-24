#!/usr/bin/env bash
set -euo pipefail
usage() { echo "Usage: $0 <host> <env-file> [<sha256:image-id>] | --prune <host>" >&2; exit 2; }
prune=false
if [[ "${1:-}" == --prune ]]; then
  [[ $# -eq 2 ]] || usage
  prune=true
  host=$2
else
  [[ $# -ge 2 && $# -le 3 ]] || usage
  host=$1
  env_file=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
  [[ -r "$env_file" ]] || { echo 'Env file is not readable' >&2; exit 2; }
  for key in IDP_DOMAIN IDP_USERS_B64 GITHUB_TOKEN POSTGRES_PASSWORD BACKSTAGE_TOKEN AWS_REGION SSH_CA_SECRET_ID AZURE_READER_SECRET_ID \
    K3S_VERSION K3S_TOKEN CA_VERSION IDP_PUBLIC_IP AWS_WORKER_GROUPS AZURE_SUBSCRIPTION_ID AZURE_TENANT_ID AZURE_WORKERS_RG \
    AZURE_WORKER_SCALE_SETS AZURE_AUTOSCALER_CLIENT_ID; do
    grep -qE "^${key}=.+" "$env_file" || { echo "Missing env key: $key" >&2; exit 2; }
  done
  image=${3:-}
fi
[[ "$host" =~ ^[a-zA-Z0-9.-]+$ ]] || { echo 'Invalid host' >&2; exit 2; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
# A single ship/maintenance operation may use the host-local registry from this checkout.
lock="$root/.deploy-lock"
mkdir "$lock" 2>/dev/null || { echo 'An IDP deploy or image maintenance is already running' >&2; exit 1; }
ssh_opts=(-i "$HOME/.ssh/id_ed25519" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
target="ubuntu@$host"
container=""
socket_dir=""
cleanup() {
  if [[ -n "$container" ]]; then docker rm "$container" >/dev/null 2>&1 || true; fi
  if [[ -n "$socket_dir" && -S "$socket_dir/s" ]]; then ssh -S "$socket_dir/s" -O exit "$target" 2>/dev/null || true; fi
  if [[ -n "$socket_dir" ]]; then rm -rf "$socket_dir"; fi
  rm -f "$lock/docker-compose.yml" "$lock/Caddyfile" "$lock/cluster-install.sh"
  rmdir "$lock"
}
trap cleanup EXIT
# Unix socket paths are limited to 104 bytes on macOS, and ssh appends a random suffix while
# creating one. Keep the tunnel's control socket short and independent of the checkout location.
socket_dir=$(mktemp -d /tmp/cf-idp.XXXXXX)
tunnel="$socket_dir/s"

if [[ "$prune" == true ]]; then
  ssh "${ssh_opts[@]}" "$target" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/idp
# Backstage pulls only on deploy. Keep the registry offline during collection, not the app.
docker compose stop registry
trap 'docker compose up -d registry' EXIT
docker compose run --rm --no-deps --pull never -T --entrypoint bin/registry registry \
  garbage-collect --delete-untagged /etc/docker/registry/config.yml
docker image prune -f --filter label=com.compute-factory.artifact=idp
REMOTE
  exit 0
fi

if [[ -z "$image" ]]; then
  image=$(bash "$root/deploy/build.sh")
  echo "Built artifact $image"
else
  echo "Reusing local artifact $image (no build)"
fi
[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'Supply the full local image ID printed by deploy/build.sh' >&2; exit 2; }
metadata=$(docker image inspect --format '{{.Os}}/{{.Architecture}} {{index .Config.Labels "com.compute-factory.artifact"}}' "$image")
[[ "$metadata" == 'linux/arm64 idp' ]] || { echo 'Expected a Vendy IDP linux/arm64 artifact' >&2; exit 2; }

start=$SECONDS
# Use the files from the same artifact, not the possibly changed checkout. No container is started.
container=$(docker create --pull=never --platform linux/arm64 "$image")
docker cp "$container:/app/deploy/docker-compose.yml" "$lock/docker-compose.yml"
docker cp "$container:/app/deploy/Caddyfile" "$lock/Caddyfile"
docker cp "$container:/app/deploy/cluster-install.sh" "$lock/cluster-install.sh"
docker compose --env-file "$env_file" -f "$lock/docker-compose.yml" config --no-env-resolution --quiet
ssh "${ssh_opts[@]}" "$target" 'mkdir -p /opt/idp && chmod 700 /opt/idp'
scp "${ssh_opts[@]}" "$lock/docker-compose.yml" "$lock/Caddyfile" "$lock/cluster-install.sh" "$target:/opt/idp/"
# Feed the env over stdin, creating it with restrictive permissions from the start.
ssh "${ssh_opts[@]}" "$target" 'umask 077; cat > /opt/idp/.env' < "$env_file"
# Ship the image through a registry on the host (bound to 127.0.0.1 there) over an SSH tunnel.
# docker push uploads only the compressed layers the host lacks, not the whole image each time.
ssh "${ssh_opts[@]}" "$target" 'cd /opt/idp && docker compose up -d registry' </dev/null
echo "Prepare deployment: $((SECONDS - start))s"
start=$SECONDS
ssh "${ssh_opts[@]}" -M -S "$tunnel" -o ExitOnForwardFailure=yes -f -N \
  -L 127.0.0.1:15000:127.0.0.1:15000 "$target"
registry_ready=false
for _ in $(seq 1 30); do
  if curl -fs --max-time 2 -o /dev/null http://127.0.0.1:15000/v2/; then registry_ready=true; break; fi
  sleep 1
done
[[ "$registry_ready" == true ]] || { echo 'IDP registry not ready through SSH tunnel' >&2; exit 1; }
docker tag "$image" localhost:15000/compute-factory-idp:latest
docker push localhost:15000/compute-factory-idp:latest
ssh -S "$tunnel" -O exit "$target" 2>/dev/null
echo "Upload artifact: $((SECONDS - start))s"
start=$SECONDS
# The containers cluster (k3s, autoscalers, the IDP's kube credentials in /opt/idp/kube) must be in
# place before Backstage starts. Pull and verify the image first: the installer uses its AWS SDK
# to read the Azure Reader secret with the host role.
ssh "${ssh_opts[@]}" "$target" bash -s -- "$image" <<'REMOTE'
set -euo pipefail
cd /opt/idp
expected=$1
docker compose pull backstage
actual=$(docker image inspect --format '{{.Id}}' localhost:15000/compute-factory-idp:latest)
[[ "$actual" == "$expected" ]] || { echo "Pulled $actual, expected $expected; not restarting Backstage" >&2; exit 1; }
bash ./cluster-install.sh .env "$expected" </dev/null
REMOTE
echo "Containers cluster: $((SECONDS - start))s"
start=$SECONDS
ssh "${ssh_opts[@]}" "$target" bash -s -- "$image" <<'REMOTE'
set -euo pipefail
cd /opt/idp
expected=$1
previous_caddy=$(docker compose ps --quiet caddy)
docker compose up -d --remove-orphans
container=$(docker compose ps --all --quiet backstage)
[[ -n "$container" && "$(docker inspect --format '{{.Image}}' "$container")" == "$expected" ]] \
  || { echo "Backstage container does not use $expected" >&2; exit 1; }
# A new Caddy reads the packaged file at startup; only a reused running container needs a reload.
caddy=$(docker compose ps --all --quiet caddy)
[[ -n "$caddy" ]] || { echo 'Caddy container was not created' >&2; exit 1; }
if [[ "$caddy" == "$previous_caddy" ]]; then
  reloaded=false
  for _ in $(seq 1 15); do
    if docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile </dev/null; then
      reloaded=true
      break
    fi
    sleep 2
  done
  [[ "$reloaded" == true ]] || { echo 'Caddy could not reload its config' >&2; exit 1; }
fi
echo "Backstage container verified: $expected"
REMOTE
echo "Roll out artifact: $((SECONDS - start))s"
