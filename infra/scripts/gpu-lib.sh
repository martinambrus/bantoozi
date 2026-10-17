# GPU detection for the local Ollama server (D-263, ported from haive's scripts/dev.sh). Sourced by
# deploy.sh and ollama-dev.sh; defines functions only.
#
#   gpu_detect <requested> <infra-dir>
#     requested: auto (default) | cpu | nvidia | vulkan  (BANTOOZI_GPU)
#     sets GPU_MODE   nvidia | vulkan | cpu | cpu-forced
#          GPU_FILES  compose `-f <override>` arguments to add (empty on the CPU)
#          GPU_NOTE   one line for the operator
#     returns 1 (with GPU_NOTE saying why) when an explicitly requested GPU is not usable.
#
# Auto prefers NVIDIA (nvidia-smi sees a GPU and Docker exposes the nvidia runtime), then Vulkan
# (DRI render nodes: Intel iGPU/Arc, AMD), else the CPU. An NVIDIA GPU that Docker cannot use is
# reported as degraded instead of silently running on the CPU. The Vulkan override is safe to
# layer whenever render nodes exist: Ollama falls back to the CPU if Vulkan cannot start.
#
#   gpu_processor <compose-command...>
#     prints the PROCESSOR column `ollama ps` reports for the loaded models (e.g. "100% GPU").

# Whether Docker exposes the `nvidia` runtime. Asks the documented --format field instead of
# grepping the human-readable `docker info` banner; bounded, since a hung daemon must not hang the
# caller.
gpu_has_nvidia_runtime() {
  timeout 15 docker info --format '{{range $name, $_ := .Runtimes}}{{$name}}{{"\n"}}{{end}}' 2>/dev/null |
    grep -qx nvidia
}

gpu_has_nvidia_device() {
  command -v nvidia-smi >/dev/null 2>&1 && timeout 15 nvidia-smi -L >/dev/null 2>&1
}

gpu_has_render_node() {
  compgen -G '/dev/dri/renderD*' >/dev/null 2>&1
}

gpu_detect() {
  local requested="${1:-auto}" infra="$2"
  GPU_MODE=cpu
  GPU_FILES=()
  GPU_NOTE=""
  case "$requested" in
    cpu)
      GPU_MODE=cpu-forced
      GPU_NOTE="BANTOOZI_GPU=cpu: Ollama runs on the CPU (GPU probes skipped)"
      return 0
      ;;
    nvidia)
      if gpu_has_nvidia_device && gpu_has_nvidia_runtime; then
        GPU_MODE=nvidia
        GPU_FILES=(-f "$infra/compose.gpu.yml")
        GPU_NOTE="BANTOOZI_GPU=nvidia: Ollama on the NVIDIA GPU"
        return 0
      fi
      GPU_NOTE="BANTOOZI_GPU=nvidia, but $(gpu_has_nvidia_device && echo 'Docker has no nvidia runtime (install the NVIDIA Container Toolkit)' || echo 'nvidia-smi sees no GPU')"
      return 1
      ;;
    vulkan)
      if gpu_has_render_node; then
        GPU_MODE=vulkan
        GPU_FILES=(-f "$infra/compose.vulkan.yml")
        GPU_NOTE="BANTOOZI_GPU=vulkan: Ollama on the GPU through Vulkan"
        return 0
      fi
      GPU_NOTE="BANTOOZI_GPU=vulkan, but the host has no /dev/dri render node"
      return 1
      ;;
    auto | '') ;;
    *)
      GPU_NOTE="unknown BANTOOZI_GPU value: $requested (auto, cpu, nvidia or vulkan)"
      return 1
      ;;
  esac
  if gpu_has_nvidia_device; then
    if gpu_has_nvidia_runtime; then
      GPU_MODE=nvidia
      GPU_FILES=(-f "$infra/compose.gpu.yml")
      GPU_NOTE="NVIDIA GPU detected: Ollama on the GPU"
      return 0
    fi
    GPU_NOTE="WARNING: an NVIDIA GPU is present but Docker has no nvidia runtime (NVIDIA Container Toolkit): Ollama runs on the CPU, much slower"
  fi
  if gpu_has_render_node; then
    GPU_MODE=vulkan
    GPU_FILES=(-f "$infra/compose.vulkan.yml")
    GPU_NOTE="${GPU_NOTE:+$GPU_NOTE; }Vulkan render node detected (Intel/AMD): Ollama on the GPU through Vulkan"
    return 0
  fi
  GPU_NOTE="${GPU_NOTE:-No GPU usable by Docker: Ollama runs on the CPU}"
  return 0
}

gpu_processor() {
  "$@" exec -T ollama ollama ps 2>/dev/null | awk 'NR > 1 && NF { for (i = 1; i <= NF; i++) if ($i ~ /^(GPU|CPU|CPU\/GPU)$/) print $(i - 1), $i }' | sort -u | paste -sd ',' -
}
