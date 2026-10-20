"""Skip runtime work only for proven documentation-only changes."""

import os
from pathlib import Path
import re
import subprocess


def is_documentation(path):
    return path == "README.md" or (path.startswith("docs/") and path.endswith(".md"))


def changed_files(event, base):
    if event not in ("pull_request", "push") or not re.fullmatch(r"[0-9a-f]{40}", base or "") or base == "0" * 40:
        return None
    result = subprocess.run(
        ["git", "diff", "--no-renames", "--name-only", "-z", base, "HEAD", "--"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode:
        return None  # Missing history must run all checks, never silently skip them.
    return [path.decode("utf-8") for path in result.stdout.split(b"\0") if path]


def runtime_required(files):
    return not files or any(not is_documentation(path) for path in files)


def main():
    base = os.environ.get("BASE_SHA", "")
    files = changed_files(os.environ.get("GITHUB_EVENT_NAME", ""), base)
    if files:
        docs = [path for path in files if is_documentation(path)]
        if docs:
            subprocess.run(["git", "diff", "--check", base, "HEAD", "--", *docs], check=True)
            for path in docs:
                if Path(path).is_file():
                    Path(path).read_text(encoding="utf-8")
    # A docs push can cancel a preceding, still-running code push. Main must
    # always verify the whole current tree; a PR diff includes its full changes.
    runtime = os.environ.get("GITHUB_EVENT_NAME") != "pull_request" or runtime_required(files)
    value = "true" if runtime else "false"
    print(f"runtime={value}")
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a", encoding="utf-8") as stream:
            stream.write(f"runtime={value}\n")
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a", encoding="utf-8") as stream:
            stream.write("## Verification scope\n\n" + (
                "Full runtime checks required (runtime changes, manual run, or unproven diff).\n"
                if runtime else "Documentation-only change: UTF-8 and diff checks passed; runtime unchanged.\n"
            ))


if __name__ == "__main__":
    main()
