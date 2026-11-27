#!/usr/bin/env bash
set -euo pipefail
usage() { echo "Usage: $0 <host> <env-file> [<sha256:image-id> | --ghcr <digest-ref> <image-id>] | --prune <host>" >&2; exit 2; }
prune=false
reference=""
if [[ "${1:-}" == --prune ]]; then
  [[ $# -eq 2 ]] || usage
  prune=true
  host=$2
else
  [[ $# == 2 || $# == 3 || ( $# == 5 && $3 == --ghcr ) ]] || usage
  host=$1
  env_file=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
  [[ -r "$env_file" ]] || { echo 'Env file is not readable' >&2; exit 2; }
  for key in IDP_DOMAIN IDP_USERS_B64 GITHUB_TOKEN POSTGRES_PASSWORD BACKSTAGE_TOKEN AWS_REGION SSH_CA_SECRET_ID AZURE_READER_SECRET_ID \
    K3S_VERSION K3S_TOKEN CA_VERSION IDP_PUBLIC_IP AWS_WORKER_GROUPS AZURE_SUBSCRIPTION_ID AZURE_TENANT_ID AZURE_WORKERS_RG \
    AZURE_WORKER_SCALE_SETS AZURE_AUTOSCALER_CLIENT_ID; do
    grep -qE "^${key}=.+" "$env_file" || { echo "Missing env key: $key" >&2; exit 2; }
  done
  if [[ $# == 5 ]]; then
    reference=$4
    image=$5
    [[ "$reference" =~ ^ghcr\.io/amirasyraf/vendy-idp@sha256:[0-9a-f]{64}$ ]] || usage
    [[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || usage
    [[ -z "${GHCR_PULL_USER:-}" && -z "${GHCR_PULL_TOKEN:-}" ||
      ( "${GHCR_PULL_USER:-}" =~ ^[a-zA-Z0-9-]+$ && -n "${GHCR_PULL_TOKEN:-}" ) ]] || {
      echo 'Set both GHCR_PULL_USER and GHCR_PULL_TOKEN for a private package' >&2; exit 2;
    }
  else
    image=${3:-}
  fi
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
remote_dir=""
cleanup() {
  if [[ -n "$container" ]]; then docker rm "$container" >/dev/null 2>&1 || true; fi
  if [[ -n "$socket_dir" && -S "$socket_dir/s" ]]; then ssh -S "$socket_dir/s" -O exit "$target" 2>/dev/null || true; fi
  if [[ -n "$socket_dir" ]]; then rm -rf "$socket_dir"; fi
  if [[ -n "$remote_dir" ]]; then
    ssh "${ssh_opts[@]}" "$target" "rm -rf -- '$remote_dir'" </dev/null || true
  fi
  rm -f "$lock/docker-compose.yml" "$lock/Caddyfile" "$lock/cluster-install.sh"
  rmdir "$lock"
}
trap cleanup EXIT
# Unix socket paths are limited to 104 bytes on macOS, and ssh appends a random suffix while
# creating one. Keep the tunnel's control socket short and independent of the checkout location.
socket_dir=$(mktemp -d /tmp/cf-idp.XXXXXX)
tunnel="$socket_dir/s"
registry_repo=localhost:15000/compute-factory-idp

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

start=$SECONDS
if [[ -n "$reference" ]]; then
  remote_dir=$(ssh "${ssh_opts[@]}" "$target" 'umask 077; mktemp -d /tmp/cf-idp.XXXXXXXX')
  [[ "$remote_dir" =~ ^/tmp/cf-idp\.[a-zA-Z0-9]{8}$ ]] || { remote_dir=""; exit 1; }
  if [[ -n "${GHCR_PULL_TOKEN:-}" ]]; then
    printf '%s' "$GHCR_PULL_TOKEN" | ssh "${ssh_opts[@]}" "$target" \
      "umask 077; docker --config '$remote_dir/docker' login ghcr.io -u '$GHCR_PULL_USER' --password-stdin"
  fi
  ssh "${ssh_opts[@]}" "$target" bash -s -- "$reference" "$image" "$remote_dir" <<'REMOTE'
set -euo pipefail
ref=$1 expected=$2 stage=$3
trap 'rm -rf -- "$stage/docker"' EXIT
timeout 300 docker --config "$stage/docker" pull "$ref"
read -r host_id metadata < <(docker image inspect \
  --format '{{.Id}} {{.Os}}/{{.Architecture}} {{index .Config.Labels "com.compute-factory.artifact"}}' "$ref")
[[ "$metadata" == 'linux/arm64 idp' && ( "$host_id" == "$expected" || "$host_id" == "${ref#*@}" ) ]] || {
  echo "Unexpected image metadata: $host_id $metadata" >&2; exit 1;
}
docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ref" | grep -Fx "$ref" >/dev/null
container=$(docker create --pull=never "$ref")
trap 'docker rm "$container" >/dev/null; rm -rf -- "$stage/docker"' EXIT
for file in docker-compose.yml Caddyfile cluster-install.sh; do
  docker cp "$container:/app/deploy/$file" "$stage/$file"
done
REMOTE
  ssh "${ssh_opts[@]}" "$target" "umask 077; cat > '$remote_dir/.env'" < "$env_file"
  shipped=$(ssh "${ssh_opts[@]}" "$target" bash -s -- "$reference" "$remote_dir" "$registry_repo" <<'REMOTE'
set -euo pipefail
source_image=$1 stage=$2 registry_repo=$3
docker compose --env-file "$stage/.env" -f "$stage/docker-compose.yml" config --no-env-resolution --quiet
install -d -m 700 /opt/idp
install -m 600 "$stage/.env" /opt/idp/.env
install -m 644 "$stage"/{docker-compose.yml,Caddyfile,cluster-install.sh} /opt/idp/
cd /opt/idp
docker compose up -d registry </dev/null >&2
for attempt in $(seq 1 30); do
  if curl -fs --max-time 2 -o /dev/null http://127.0.0.1:15000/v2/; then break; fi
  [[ "$attempt" != 30 ]] || { echo 'IDP registry not ready on the host' >&2; exit 1; }
  sleep 1
done
docker tag "$source_image" "$registry_repo:latest"
# Push the verified host platform, not an index with manifests the host did not pull.
timeout 180 docker push --platform linux/arm64 "$registry_repo:latest" | awk '{ print > "/dev/stderr" } $2 == "digest:" && $4 == "size:" {print $3}'
REMOTE
  )
  echo "Pulled and staged $reference on the IDP host: $((SECONDS - start))s"
else
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
docker tag "$image" "$registry_repo:latest"
shipped=$(docker push "$registry_repo:latest" | awk '{ print > "/dev/stderr" } $2 == "digest:" && $4 == "size:" {print $3}')
ssh -S "$tunnel" -O exit "$target" 2>/dev/null
echo "Upload artifact: $((SECONDS - start))s"
fi
[[ "$shipped" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'Could not verify the registry push digest' >&2; exit 1; }
start=$SECONDS
# The containers cluster (k3s, autoscalers, the IDP's kube credentials in /opt/idp/kube) must be in
# place before Backstage starts. Verify the exact pushed manifest before using the host-local
# image ID (which can differ from the runner's) for the installer and running container checks.
host_image=$(ssh "${ssh_opts[@]}" "$target" bash -s -- "$registry_repo" "$shipped" <<'REMOTE'
set -euo pipefail
cd /opt/idp
repo=$1 digest=$2
docker compose pull backstage >&2
docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$repo:latest" | grep -Fx "$repo@$digest" >/dev/null ||
  { echo "Pulled image does not match $repo@$digest; not restarting Backstage" >&2; exit 1; }
actual=$(docker image inspect --format '{{.Id}}' "$repo:latest")
bash ./cluster-install.sh .env "$actual" </dev/null >&2
printf '%s\n' "$actual"
REMOTE
)
[[ "$host_image" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'Could not verify the host image ID' >&2; exit 1; }
echo "Containers cluster: $((SECONDS - start))s"
start=$SECONDS
ssh "${ssh_opts[@]}" "$target" bash -s -- "$host_image" <<'REMOTE'
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
