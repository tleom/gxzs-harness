"""Manager credentials scoped to one currently registered owner host."""
import hashlib
import hmac
import json
import base64

OWNER_ACTIONS = frozenset({"files", "personal-resources", "personal-mcp", "office-preview", "touch"})


def owner_token(root_token, owner, workspace, generation, instance):
    message = f"manager\n{owner}\n{workspace}\n{int(generation)}\n{instance}"
    return base64.urlsafe_b64encode(hmac.new(root_token.encode(), message.encode(), hashlib.sha256).digest()).decode().rstrip('=')


def assertion_key(root_key, owner, generation, instance):
    message = f"assertion\n{owner}\n{int(generation)}\n{instance}"
    return base64.b64encode(hmac.new(base64.b64decode(root_key, validate=True), message.encode(), hashlib.sha256).digest()).decode()


def authorize(headers, root_token, hosts_root, workspace, action):
    supplied = headers.get("Authorization", "")
    if hmac.compare_digest(supplied, "Bearer " + root_token):
        return "root"
    if action not in OWNER_ACTIONS:
        raise PermissionError("Manager operation requires coordinator credentials")
    try:
        record = json.loads((hosts_root / workspace / "host.json").read_text(encoding="utf-8"))
        generation = int(headers.get("X-GXZS-Host-Generation", "0"))
        owner, instance = headers.get("X-GXZS-Owner", ""), headers.get("X-GXZS-Host-Instance", "")
        if (record["owner_id"], record["workspace_id"], record["generation"], record["instance_id"]) != (owner, workspace, generation, instance):
            raise PermissionError("Manager host identity mismatch")
        if record.get("state", "ready" if record.get("ready") else "provisioning") not in {"ready", "provisioning", "draining"}:
            raise PermissionError("Manager host generation has been fenced")
        expected = owner_token(root_token, owner, workspace, generation, instance)
        if not hmac.compare_digest(supplied, "Bearer " + expected):
            raise PermissionError("Manager credential is invalid")
        return "owner"
    except (OSError, ValueError, KeyError) as error:
        raise PermissionError("Manager host is not registered") from error
