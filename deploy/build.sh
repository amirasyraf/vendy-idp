#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 0 ]]; then echo "Usage: $0" >&2; exit 2; fi
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

lock="$root/.build-lock"
mkdir "$lock" 2>/dev/null || { echo 'An IDP build is already running' >&2; exit 1; }
tsc_pid=""
cleanup() {
  if [[ -n "$tsc_pid" ]]; then
    kill "$tsc_pid" 2>/dev/null || true
    wait "$tsc_pid" 2>/dev/null || true
  fi
  rm -f "$lock/tsc.log"
  rmdir "$lock"
}
trap cleanup EXIT

timed() {
  local label="$1" start=$SECONDS status=0
  shift
  printf '==> %s\n' "$label" >&2
  "$@" >&2 || status=$?
  printf '    %s: %ss (exit %s)\n' "$label" "$((SECONDS - start))" "$status" >&2
  return "$status"
}

export NODE_OPTIONS='--no-node-snapshot --max-old-space-size=3072'
export CARGO_BUILD_JOBS=2 RAYON_NUM_THREADS=2 MAKEFLAGS=-j2
mise trust "$root/mise.toml" >/dev/null
yarn=(mise exec -- node .yarn/releases/yarn-4.13.0.cjs)
timed 'Install dependencies' "${yarn[@]}" install --immutable
timed 'Validate catalog YAML' mise exec -- node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { parseAllDocuments } from "yaml";
  const documents = parseAllDocuments(readFileSync("catalog/org.yaml", "utf8"));
  const errors = documents.flatMap(document => document.errors);
  if (errors.length) {
    for (const error of errors) console.error(error.message);
    process.exit(1);
  }
'
# Both must pass before the image can be packaged. Keep stdout reserved for the image ID.
timed 'Type check' "${yarn[@]}" tsc >"$lock/tsc.log" 2>&1 &
tsc_pid=$!
bundle_status=0
GITHUB_TOKEN=build-only timed 'Bundle Backstage' "${yarn[@]}" build:backend || bundle_status=$?
type_status=0
wait "$tsc_pid" || type_status=$?
tsc_pid=""
cat "$lock/tsc.log" >&2
(( bundle_status == 0 && type_status == 0 )) || exit 1

# A plain single-platform manifest keeps the host-local registry's garbage collection simple.
timed 'Package Docker image' docker buildx build --platform linux/arm64 --provenance=false --load \
  --label org.opencontainers.image.source=https://github.com/amirasyraf/vendy-idp \
  -t compute-factory-idp:latest .
docker image inspect --format '{{.Id}}' compute-factory-idp:latest
