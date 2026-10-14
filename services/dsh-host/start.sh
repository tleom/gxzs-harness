#!/bin/sh
set -eu
mkdir -p "$DSH_HOME/profiles/workbench"
# DSH writes the compiled cordis.yml into its profile. Keep that directory
# owner-writable while sharing only immutable installed dependencies.
for file in package.json package-lock.json; do
  cp "/opt/workbench/profiles/workbench/$file" "$DSH_HOME/profiles/workbench/$file"
done
node /opt/workbench/scripts/migrate-platform-patch.mjs
for target in "$DSH_HOME/profiles/workbench/node_modules" "$DSH_HOME/packages"; do
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    # Preserve an older deployment's directory until its operator retires it.
    backup="$target.before-image-$(date +%s)-$$"
    mv "$target" "$backup"
  fi
done
ln -sfn /opt/workbench/profiles/workbench/node_modules "$DSH_HOME/profiles/workbench/node_modules"
ln -sfn /opt/workbench/packages "$DSH_HOME/packages"
for file in settings.yaml .credentials.yaml; do
  if [ ! -f "$DSH_HOME/$file" ] && [ -f "/run/gxzs/$file" ]; then
    cp "/run/gxzs/$file" "$DSH_HOME/$file"
    chmod 600 "$DSH_HOME/$file"
  fi
done
node /opt/workbench/relay.mjs &
exec /opt/workbench/profiles/workbench/node_modules/.bin/dsh --profile workbench --port 3080 --no-open
