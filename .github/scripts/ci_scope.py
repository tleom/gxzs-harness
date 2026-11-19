"""Select checks for known paths; run full verification when scope is uncertain."""

import os
from pathlib import Path
import re
import subprocess


def is_documentation(path):
    return path == "README.md" or (path.startswith("docs/") and path.endswith(".md"))


def changed_files(event, base):
    if event not in {"pull_request", "push", "comparison"} or not re.fullmatch(r"[0-9a-f]{40}", base or "") or base == "0" * 40:
        return None
    result = subprocess.run(
        ["git", "diff", "--no-renames", "--name-only", "-z", base, "HEAD", "--"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode:
        return None  # Missing history must run all checks, never silently skip them.
    return [path.decode("utf-8") for path in result.stdout.split(b"\0") if path]


IDENTITY_MIGRATION_FILES = {
    "scripts/migrate_host_identity.py",
    "services/sandbox-manager/README.md",
    "services/sandbox-manager/tests/test_migrate_host_identity.py",
}


def verification_scope(files):
    if not files:
        return "full"
    runtime_files = {path for path in files if not is_documentation(path)}
    if not runtime_files:
        return "docs"
    if all(re.fullmatch(r"packages/[^/]+/test/[^/]+\.test\.(?:js|mjs|cjs|ts)", path)
           for path in runtime_files):
        return "node-tests"
    if runtime_files <= IDENTITY_MIGRATION_FILES:
        return "identity-migration"
    return "full"


def main():
    base = os.environ.get("BASE_SHA", "")
    event = os.environ.get("GITHUB_EVENT_NAME", "")
    if event == "workflow_dispatch" and os.environ.get("COMPARISON_BASE"):
        event = "comparison"
        base = os.environ["COMPARISON_BASE"]
    files = changed_files(event, base)
    if files:
        docs = [path for path in files if is_documentation(path)]
        if docs:
            subprocess.run(["git", "diff", "--check", base, "HEAD", "--", *docs], check=True)
            for path in docs:
                if Path(path).is_file():
                    Path(path).read_text(encoding="utf-8")
    scope = verification_scope(files)
    print(f"scope={scope}")
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a", encoding="utf-8") as stream:
            stream.write(f"scope={scope}\n")
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a", encoding="utf-8") as stream:
            stream.write(f"## Verification scope\n\nSelected: **{scope}**.\n")


if __name__ == "__main__":
    main()
