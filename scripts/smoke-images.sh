#!/usr/bin/env bash
set -euo pipefail
host_image=${1:?host image}
manager_image=${2:?manager image}
sandbox_image=${3:?sandbox image}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
container_id=''
cleanup() { if [[ -n "$container_id" ]]; then docker rm -f "$container_id" >/dev/null; fi; }
trap cleanup EXIT

docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 1g --cpus 1 --pids-limit 128 --entrypoint node "$host_image" \
  /opt/workbench/check-runtime-imports.mjs
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 1g --cpus 1 --pids-limit 128 --entrypoint node \
  -v "$script_dir/smoke-host-bootstrap.mjs:/smoke-host-bootstrap.mjs:ro" "$host_image" /smoke-host-bootstrap.mjs
docker run --rm --network none --entrypoint python "$manager_image" \
  -I -c "import sys;sys.path.insert(0,'/app');import hosts,mcp_runtime,mcp_authorization,owner_auth;from global_memory import catalog;assert catalog()['tools']"
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 2g --cpus 2 --pids-limit 256 --entrypoint node "$sandbox_image" /opt/workbench/verify-runtime.mjs

container_id=$(docker run -d --network none --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 2g --cpus 2 --pids-limit 256 "$sandbox_image" sleep 180)
for attempt in {1..15}; do
  if docker exec "$container_id" /usr/local/bin/python -I -S -c \
      "import socket;assert socket.create_connection(('127.0.0.1',2222),2).recv(128).startswith(b'SSH-')"; then break; fi
  if [[ $attempt == 15 ]]; then docker logs "$container_id"; exit 1; fi
  sleep 1
done
python3 "$script_dir/smoke-sandbox-ssh.py" "$container_id"
docker exec "$container_id" /opt/office/python/bin/python -c \
  "from docx import Document;d=Document();d.add_paragraph('中文预览验证');d.save('/tmp/check.docx')"
docker exec "$container_id" /usr/bin/python3 -I /opt/office/uno_worker.py /tmp/check.docx /tmp/check.pdf convert
docker exec "$container_id" /opt/office/python/bin/python -c \
  "import pymupdf;d=pymupdf.open('/tmp/check.pdf');assert '中文预览验证' in ''.join(p.get_text() for p in d)"
docker exec "$container_id" /usr/local/bin/python -I -S -c \
  "import os;assert os.getuid()==1000;assert not os.access('/usr/local/bin/python',os.W_OK);assert not os.access('/opt/dsh/node_modules',os.W_OK);assert not os.path.exists('/var/run/docker.sock')"
printf '%s\n' 'All image smoke checks passed'
