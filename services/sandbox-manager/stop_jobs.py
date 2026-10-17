"""Stop only shellctl jobs belonging to one conversation Home, including untracked jobs."""
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
from uuid import UUID

binding = str(UUID(json.load(sys.stdin)["binding_id"]))
homes = {base + "/" + binding for base in ("/home/gxzs", "/home/dify")}
stopped = 0
roots = {Path(base + "/.local/share/shellctl/jobs").resolve() for base in ("/home/gxzs", "/home/dify")}
# The new image aliases /home/dify to /home/gxzs. Resolve before scanning so
# an old job is handled once, including while the previous image still runs.
for entry in (entry for root in roots for entry in root.glob("*")):
    environment = entry / ".job-env.json"
    if entry.is_symlink() or environment.is_symlink() or not environment.is_file():
        continue
    if json.loads(environment.read_text()).get("HOME") not in homes:
        continue
    request = Request("http://127.0.0.1:5004/v1/jobs/" + quote(entry.name, safe="") + "?force=true&grace_seconds=1",
        method="DELETE", headers={"Authorization": "Bearer " + os.environ["SHELLCTL_AUTH_TOKEN"]})
    try:
        with urlopen(request, timeout=15) as response:
            result = json.load(response)
            if not result.get("deleted"):
                raise RuntimeError("Shell job cleanup was not confirmed")
    except HTTPError as error:
        if error.code != 404:
            raise
    stopped += 1
print(json.dumps({"stopped": stopped}))
