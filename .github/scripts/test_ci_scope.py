import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from ci_scope import changed_files, main, runtime_required


class ScopeTests(unittest.TestCase):
    def test_only_root_readme_and_markdown_docs_are_lightweight(self):
        self.assertFalse(runtime_required(["README.md", "docs/ci.md", "docs/nested/guide.md"]))
        for path in ["packages/pkg/README.md", "docs/schema.json", "scripts/check.mjs", ".github/workflows/verify.yml", "pnpm-lock.yaml", "services/sandbox/Dockerfile", "unknown.md"]:
            with self.subTest(path=path):
                self.assertTrue(runtime_required(["docs/ci.md", path]))

    def test_unproven_or_empty_diff_requires_full_checks(self):
        self.assertTrue(runtime_required(None))
        self.assertTrue(runtime_required([]))
        for event, base in [("workflow_dispatch", "a" * 40), ("push", "0" * 40), ("push", ""), ("push", "--help")]:
            with self.subTest(event=event, base=base):
                self.assertIsNone(changed_files(event, base))
        with patch("ci_scope.subprocess.run", return_value=subprocess.CompletedProcess([], 128, b"", b"bad revision")):
            self.assertIsNone(changed_files("push", "a" * 40))

    def test_git_rename_keeps_the_deleted_runtime_path_and_handles_newlines(self):
        with tempfile.TemporaryDirectory() as directory:
            previous = os.getcwd()
            try:
                os.chdir(directory)
                def git(*args):
                    return subprocess.check_output(["git", *args], stderr=subprocess.PIPE).decode().strip()
                git("init", "-q")
                git("config", "user.name", "CI test")
                git("config", "user.email", "ci-test@example.invalid")
                Path("runtime.js").write_text("same content\n", encoding="utf-8")
                git("add", ".")
                git("commit", "-qm", "base")
                base = git("rev-parse", "HEAD")
                Path("docs").mkdir()
                git("mv", "runtime.js", "docs/guide.md")
                git("commit", "-qm", "rename")
                paths = changed_files("pull_request", base)
                self.assertEqual(set(paths), {"runtime.js", "docs/guide.md"})
                self.assertTrue(runtime_required(paths))
                docs_base = git("rev-parse", "HEAD")
                Path("docs/guide.md").write_text("updated\n", encoding="utf-8")
                git("add", ".")
                git("commit", "-qm", "docs")
                self.assertFalse(runtime_required(changed_files("push", docs_base)))
                with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "pull_request", "BASE_SHA": docs_base, "GITHUB_OUTPUT": "outputs", "GITHUB_STEP_SUMMARY": "summary"}):
                    main()
                self.assertEqual(Path("outputs").read_text(), "runtime=false\n")
                with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "push", "BASE_SHA": docs_base, "GITHUB_OUTPUT": "push-outputs", "GITHUB_STEP_SUMMARY": "summary"}):
                    main()
                self.assertEqual(Path("push-outputs").read_text(), "runtime=true\n")
                whitespace_base = git("rev-parse", "HEAD")
                Path("docs/guide.md").write_text("trailing whitespace   \n", encoding="utf-8")
                git("add", ".")
                git("commit", "-qm", "invalid docs")
                with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "push", "BASE_SHA": whitespace_base, "GITHUB_OUTPUT": "blocked-outputs"}):
                    with self.assertRaises(subprocess.CalledProcessError):
                        main()
                self.assertFalse(Path("blocked-outputs").exists())
            finally:
                os.chdir(previous)
        with patch("ci_scope.subprocess.run", return_value=subprocess.CompletedProcess([], 0, b"docs/a\nb.md\0runtime\nfile.js\0", b"")):
            self.assertTrue(runtime_required(changed_files("pull_request", "a" * 40)))


if __name__ == "__main__":
    unittest.main()
