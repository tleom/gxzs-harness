#!/bin/sh
set -eu

: "${HARNESS:?set HARNESS to the repository root}"
: "${DSH_HOME:?set DSH_HOME to the disposable validation home}"

rm -rf "$DSH_HOME/profiles/workbench" "$DSH_HOME/packages/workbench-adapter" \
  "$DSH_HOME/packages/workbench-control-commands" "$DSH_HOME/packages/workbench-file-manager" \
  "$DSH_HOME/packages/workbench-platform-client" "$DSH_HOME/packages/workbench-sandbox-skills" \
  "$DSH_HOME/packages/workbench-mcp-tools"
mkdir -p "$DSH_HOME/profiles" "$DSH_HOME/packages"
cp -a "$HARNESS/profiles/workbench" "$DSH_HOME/profiles/workbench"
cp -a "$HARNESS/packages/workbench-adapter" "$DSH_HOME/packages/workbench-adapter"
cp -a "$HARNESS/packages/workbench-control-commands" "$DSH_HOME/packages/workbench-control-commands"
cp -a "$HARNESS/packages/workbench-file-manager" "$DSH_HOME/packages/workbench-file-manager"
cp -a "$HARNESS/packages/workbench-platform-client" "$DSH_HOME/packages/workbench-platform-client"
cp -a "$HARNESS/packages/workbench-sandbox-skills" "$DSH_HOME/packages/workbench-sandbox-skills"
cp -a "$HARNESS/packages/workbench-mcp-tools" "$DSH_HOME/packages/workbench-mcp-tools"
find "$DSH_HOME" -type d -name node_modules -prune -exec rm -rf {} +
cd "$DSH_HOME/profiles/workbench"
npm ci --no-audit --no-fund
ln -sfn "profiles/workbench/node_modules" "$DSH_HOME/node_modules"
