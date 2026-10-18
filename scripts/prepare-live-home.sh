#!/bin/sh
set -eu

: "${HARNESS:?set HARNESS to the repository root}"
: "${DSH_HOME:?set DSH_HOME to the disposable validation home}"
: "${GXZS_VALIDATION_ROOT:?set GXZS_VALIDATION_ROOT to the disposable validation root}"

fail() { printf '%s\n' "$1" >&2; exit 1; }

# Resolve existing symlinks before checking containment, including parent paths
# of a home that has not been created yet. This script requires GNU realpath.
HARNESS=$(realpath -e -- "$HARNESS")
validation_root=$(realpath -m -- "$GXZS_VALIDATION_ROOT")
DSH_HOME=$(realpath -m -- "$DSH_HOME")
[ "$validation_root" != / ] || fail 'Validation root cannot be /'
case "$DSH_HOME" in
  "$validation_root"/*) ;;
  *) fail 'DSH_HOME must be a strict descendant of GXZS_VALIDATION_ROOT' ;;
esac
case "$DSH_HOME/" in "$HARNESS/"*) fail 'Validation home overlaps the source repository' ;; esac
case "$HARNESS/" in "$DSH_HOME/"*) fail 'Validation home overlaps the source repository' ;; esac

packages='workbench-adapter workbench-control-commands workbench-file-manager workbench-platform-client workbench-sandbox-skills workbench-sandbox-runtime workbench-mcp-tools tool-discovery'
[ -f "$HARNESS/profiles/workbench/package-lock.json" ] || fail 'Source profile lockfile is missing'
[ -d "$HARNESS/scripts" ] || fail 'Source scripts are missing'
for package in $packages; do
  [ -d "$HARNESS/packages/$package" ] || fail 'A source package is missing'
done

marker="$DSH_HOME/.gxzs-disposable-validation-home"
expected_marker="gxzs-disposable-validation-home-v1:$DSH_HOME"
if [ -e "$marker" ] || [ -L "$marker" ]; then
  [ -f "$marker" ] && [ ! -L "$marker" ] || fail 'Invalid validation home marker'
  [ "$(cat -- "$marker")" = "$expected_marker" ] || fail 'Validation home marker does not match this path'
elif [ -e "$DSH_HOME" ]; then
  [ -d "$DSH_HOME" ] || fail 'Validation home is not a directory'
  [ -z "$(find "$DSH_HOME" -mindepth 1 -maxdepth 1 -print -quit)" ] || fail 'Existing nonempty home has no validation marker'
fi
for directory in profiles packages scripts; do
  [ ! -L "$DSH_HOME/$directory" ] || fail 'Validation home contains a symlinked working directory'
  if [ -e "$DSH_HOME/$directory" ]; then
    [ -d "$DSH_HOME/$directory" ] || fail 'Validation working path is not a directory'
  fi
done
mkdir -p "$DSH_HOME"
printf '%s\n' "$expected_marker" > "$marker"

rm -rf "$DSH_HOME/profiles/workbench" "$DSH_HOME/packages/workbench-adapter" \
  "$DSH_HOME/packages/workbench-control-commands" "$DSH_HOME/packages/workbench-file-manager" \
  "$DSH_HOME/packages/workbench-platform-client" "$DSH_HOME/packages/workbench-sandbox-skills" \
  "$DSH_HOME/packages/workbench-sandbox-runtime" "$DSH_HOME/packages/workbench-mcp-tools" \
  "$DSH_HOME/packages/tool-discovery"
mkdir -p "$DSH_HOME/profiles" "$DSH_HOME/packages" "$DSH_HOME/scripts"
cp -a "$HARNESS/profiles/workbench" "$DSH_HOME/profiles/workbench"
cp -a "$HARNESS/packages/workbench-adapter" "$DSH_HOME/packages/workbench-adapter"
cp -a "$HARNESS/packages/workbench-control-commands" "$DSH_HOME/packages/workbench-control-commands"
cp -a "$HARNESS/packages/workbench-file-manager" "$DSH_HOME/packages/workbench-file-manager"
cp -a "$HARNESS/packages/workbench-platform-client" "$DSH_HOME/packages/workbench-platform-client"
cp -a "$HARNESS/packages/workbench-sandbox-skills" "$DSH_HOME/packages/workbench-sandbox-skills"
cp -a "$HARNESS/packages/workbench-sandbox-runtime" "$DSH_HOME/packages/workbench-sandbox-runtime"
cp -a "$HARNESS/packages/workbench-mcp-tools" "$DSH_HOME/packages/workbench-mcp-tools"
cp -a "$HARNESS/packages/tool-discovery" "$DSH_HOME/packages/tool-discovery"
cp -a "$HARNESS/scripts/." "$DSH_HOME/scripts/"
find "$DSH_HOME" -type d -name node_modules -prune -exec rm -rf {} +
mkdir -p "$DSH_HOME/profiles/workbench/node_modules"
ln -sfn "profiles/workbench/node_modules" "$DSH_HOME/node_modules"
cd "$DSH_HOME/profiles/workbench"
npm ci --no-audit --no-fund
