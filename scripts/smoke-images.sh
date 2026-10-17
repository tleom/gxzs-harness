#!/usr/bin/env bash
set -euo pipefail
host_image=${1:?host image}
manager_image=${2:?manager image}
sandbox_image=${3:?sandbox image}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
container_id=''
attachment_volume=''
cleanup() {
  if [[ -n "$container_id" ]]; then docker rm -f "$container_id" >/dev/null; fi
  if [[ -n "$attachment_volume" ]]; then docker volume rm "$attachment_volume" >/dev/null; fi
}
trap cleanup EXIT

python3 "$script_dir/smoke-profile-upgrade.py" "$host_image" "$manager_image"
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 1g --cpus 1 --pids-limit 128 --entrypoint node "$host_image" \
  /opt/workbench/check-runtime-imports.mjs
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 256m --cpus 1 --pids-limit 64 --entrypoint node \
  -v "$script_dir/smoke-host-relay.mjs:/smoke-host-relay.mjs:ro" "$host_image" /smoke-host-relay.mjs
docker run --rm --network none --entrypoint python "$manager_image" \
  -I -c "import sys;sys.path.insert(0,'/app');import hosts,mcp_runtime,mcp_authorization,owner_auth;from global_memory import catalog;assert catalog()['tools']"
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 2g --cpus 2 --pids-limit 256 --entrypoint node "$sandbox_image" /opt/workbench/verify-runtime.mjs

attachment_volume="gxzs-smoke-attachments-$(date +%s)-$$"
docker volume create "$attachment_volume" >/dev/null
docker run --rm --network none --user 0 --entrypoint /usr/local/bin/python \
  -v "$attachment_volume:/srv/dsh" "$sandbox_image" -I -S -c \
  "import os;os.chown('/srv/dsh',1000,1000);os.makedirs('/srv/dsh/attachments');os.chown('/srv/dsh/attachments',1000,1000);os.chmod('/srv/dsh/attachments',0o700)"
container_id=$(docker run -d --network none --cap-drop ALL --security-opt no-new-privileges:true \
  --mount "type=volume,source=$attachment_volume,destination=/srv/dsh/attachments,volume-subpath=attachments,readonly" \
  --memory 2g --cpus 2 --pids-limit 256 "$sandbox_image" sleep 600)
for attempt in {1..15}; do
  if docker exec "$container_id" /usr/local/bin/python -I -S -c \
      "import socket;assert socket.create_connection(('127.0.0.1',2222),2).recv(128).startswith(b'SSH-')"; then break; fi
  if [[ $attempt == 15 ]]; then docker logs "$container_id"; exit 1; fi
  sleep 1
done
python3 "$script_dir/smoke-sandbox-ssh.py" "$container_id" "$host_image"
python3 "$script_dir/smoke-planning-resources.py" "$manager_image" "$sandbox_image"
docker exec -i "$container_id" node < "$script_dir/smoke-browser-observation.cjs"
docker exec -i "$container_id" node < "$script_dir/smoke-browser-navigation.cjs"
docker exec -i "$container_id" node < "$script_dir/smoke-browser-display.cjs"
docker run --rm --network none --entrypoint node "$host_image" -e \
  "process.stdout.write(require('node:fs').readFileSync('/opt/workbench/services/browser-client/dist/client.js'))" \
  | docker exec -i "$container_id" sh -c 'cat > /tmp/workbench-browser-client.js'
docker exec -i "$container_id" node < "$script_dir/smoke-browser-client.cjs"
GXZS_SMOKE_BOOTSTRAP=1 GXZS_SMOKE_FRESH_BOOTSTRAP=1 \
  python3 "$script_dir/smoke-sandbox-ssh.py" "$container_id" "$host_image"
GXZS_SMOKE_BOOTSTRAP=1 GXZS_SMOKE_CRASH=1 GXZS_SMOKE_RUNNING=1 GXZS_SMOKE_NATIVE_ATTACHMENTS=1 GXZS_SMOKE_LEGACY_PROFILE=1 \
  python3 "$script_dir/smoke-sandbox-ssh.py" "$container_id" "$host_image"
docker exec "$container_id" /opt/office/python/bin/python -c \
  "from docx import Document;d=Document();d.add_paragraph('中文预览验证');d.save('/tmp/check.docx')"
docker exec "$container_id" /usr/bin/python3 -I /opt/office/uno_worker.py /tmp/check.docx /tmp/check.pdf convert
docker exec "$container_id" /opt/office/python/bin/python -c \
  "import pymupdf;d=pymupdf.open('/tmp/check.pdf');assert '中文预览验证' in ''.join(p.get_text() for p in d)"
docker exec "$container_id" /usr/local/bin/python -I -S -c \
  "import os;assert os.getuid()==1000;assert not os.access('/usr/local/bin/python',os.W_OK);assert not os.access('/opt/dsh/node_modules',os.W_OK);assert not os.path.exists('/var/run/docker.sock')"
python3 "$script_dir/smoke-manager-lifecycle.py" "$manager_image" "$sandbox_image" "$host_image"
printf '%s\n' 'All image smoke checks passed'
