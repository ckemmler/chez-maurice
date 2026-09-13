#!/usr/bin/env bash
# Put the current checkout live in a local Maurice container: build the
# production image, then recreate the container with the same name, volumes,
# ports, environment and log settings it has now — only the image changes.
# The data volume is untouched; migrations run at the new container's start.
#
#   ops/recreate-container.sh <container-name> [image-tag]
#   ops/recreate-container.sh <container-name> --dry-run    show the run line, touch nothing
#
# This is the deploy primitive for a container that was started by hand (the
# rehearsal instance at :13003). A compose-managed instance uses
# `docker compose up -d` instead; a remote host uses scripts/deploy.sh.
# Written for the system's bash 3.2: no mapfile, no associative arrays.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/_lib.sh"
export PATH="$HOME/.orbstack/bin:$PATH"
NAME="${1:?usage: recreate-container.sh <container-name> [image-tag]}"
TAG="${2:-$(date +%Y%m%d-%H%M%S)}"
DRY=0; [ "${2:-}" = "--dry-run" ] && { DRY=1; TAG=dry-run; }

docker inspect "$NAME" >/dev/null 2>&1 || { echo "no container named $NAME" >&2; exit 1; }

if [ "$DRY" = 0 ]; then
echo "→ build maurice:$TAG"
"$REPO/scripts/build-info.sh" >/dev/null
docker build -q -f "$REPO/infra/container/Dockerfile" --target production \
  -t "maurice:$TAG" -t maurice:production "$REPO" >/dev/null
fi

# Capture what makes this container this container.
args=(-d --name "$NAME")
args+=(--restart "$(docker inspect "$NAME" --format '{{.HostConfig.RestartPolicy.Name}}')")
n_env=0
while IFS= read -r e; do
  [ -n "$e" ] || continue
  case "$e" in PATH=*|HOME=*|DEBIAN_FRONTEND=*|VIRTUAL_ENV=*|NODE_ENV=*|CALIBRE_PYTHON=*) continue ;; esac
  args+=(-e "$e"); n_env=$((n_env + 1))
done < <(docker inspect "$NAME" --format '{{range .Config.Env}}{{println .}}{{end}}')
ports=""
first_port=""
while IFS= read -r p; do
  [ -n "$p" ] || continue
  p="${p#:}"; p="${p%/tcp}"
  args+=(-p "$p"); ports="$ports $p"
  [ -n "$first_port" ] || first_port="$(echo "$p" | awk -F: '{print $(NF-1)}')"
done < <(docker inspect "$NAME" --format '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostIp}}:{{.HostPort}}:{{$p}}{{println}}{{end}}{{end}}')
vols=""
while IFS= read -r v; do
  [ -n "$v" ] || continue
  args+=(-v "$v"); vols="$vols $v"
done < <(docker inspect "$NAME" --format '{{range .Mounts}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}:{{.Destination}}{{println}}{{end}}')
log_size="$(docker inspect "$NAME" --format '{{index .HostConfig.LogConfig.Config "max-size"}}')"
log_file="$(docker inspect "$NAME" --format '{{index .HostConfig.LogConfig.Config "max-file"}}')"
[ -n "$log_size" ] && args+=(--log-opt "max-size=$log_size")
[ -n "$log_file" ] && args+=(--log-opt "max-file=$log_file")

echo "→ recreate $NAME ($n_env env, ports:$ports, volumes:$vols)"
if [ "$DRY" = 1 ]; then
  printf 'docker run'; for a in "${args[@]}"; do case "$a" in *KEY=*|*TOKEN=*|*SECRET=*) printf ' %s' "${a%%=*}=…";; *) printf ' %q' "$a";; esac; done; printf ' maurice:%s\n' "$TAG"
  exit 0
fi
docker rm -f "$NAME" >/dev/null
docker run "${args[@]}" "maurice:$TAG" >/dev/null

[ -n "$first_port" ] || { echo "✓ $NAME recreated (no published port to probe)"; exit 0; }
for _ in $(seq 1 30); do
  if out="$(curl -s -f -m 2 "http://localhost:$first_port/healthz" 2>/dev/null)"; then
    echo "✓ $NAME up on :$first_port — $out"; exit 0
  fi
  sleep 1
done
echo "✗ $NAME did not answer on :$first_port within 30 s; see docker logs $NAME" >&2
exit 1
