#!/usr/bin/env bash
# Starts the development Ollama server (infra/compose.dev.yml, profile `ollama`, D-263) on the GPU
# the host supports, pulls the models and reports where they run:
#
#   pnpm ollama:dev:up [model...]
#
# Models: the arguments, else OLLAMA_MODEL_FAST and OLLAMA_MODEL_STRONG from .env. BANTOOZI_GPU
# (environment or .env): auto (default) | cpu | nvidia | vulkan. The apps reach the server at
# http://localhost:${OLLAMA_DEV_PORT:-11435}: set OLLAMA_BASE_URL to that and OLLAMA_API_KEY to any
# value (a local server ignores it). Shared containers start with --no-recreate (CLAUDE.md); after
# changing BANTOOZI_GPU, recreate it once: docker compose -f infra/compose.dev.yml --profile ollama rm -sf ollama
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=gpu-lib.sh
. "$ROOT/infra/scripts/gpu-lib.sh"

env_value() {
  local line
  [ -f "$ROOT/.env" ] || return 0
  line="$(grep -E "^[[:space:]]*$1=" "$ROOT/.env" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"; line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

requested="${BANTOOZI_GPU:-$(env_value BANTOOZI_GPU)}"
if ! gpu_detect "${requested:-auto}" "$ROOT/infra"; then
  echo "ollama-dev: $GPU_NOTE" >&2
  exit 1
fi
echo "ollama-dev: $GPU_NOTE"

dc() { docker compose -f "$ROOT/infra/compose.dev.yml" "${GPU_FILES[@]}" --profile ollama "$@"; }
dc up -d --no-recreate --wait --wait-timeout 180 ollama

models=("$@")
if [ "${#models[@]}" -eq 0 ]; then
  for name in OLLAMA_MODEL_FAST OLLAMA_MODEL_STRONG; do
    value="$(env_value "$name")"
    [ -n "$value" ] && models+=("$value")
  done
fi
pulled=()
for model in $(printf '%s\n' "${models[@]}" | awk 'NF && !seen[$0]++'); do
  if dc exec -T ollama ollama pull "$model"; then
    pulled+=("$model")
  else
    echo "ollama-dev: could not pull $model (a cloud-only model name?): pass local models as arguments" >&2
  fi
done

if [ "${#pulled[@]}" -gt 0 ] && [ "$GPU_MODE" != cpu ] && [ "$GPU_MODE" != cpu-forced ]; then
  # Load the first model once and ask Ollama where it runs: a GPU that the container cannot use
  # makes it fall back to the CPU silently (e.g. a driver upgraded without a reboot).
  dc exec -T ollama ollama run "${pulled[0]}" "Reply with OK." >/dev/null 2>&1 || true
  where="$(gpu_processor dc)"
  echo "ollama-dev: ${pulled[0]} runs on: ${where:-unknown}"
  case "$where" in *GPU*) ;; *) echo "ollama-dev: WARNING: a GPU was detected ($GPU_MODE) but the model runs on the CPU" >&2 ;; esac
fi
echo "ollama-dev: ready at http://localhost:${OLLAMA_DEV_PORT:-11435} (OLLAMA_BASE_URL)"
