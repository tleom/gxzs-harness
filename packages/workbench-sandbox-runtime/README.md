# Workbench sandbox runtime

This package adapts upstream execution services to the owner's SSH sandbox without modifying upstream packages.

- `./subprocess` extends the SSH process provider. At initialization it resolves the configured ripgrep executable remotely and maps only the exact packaged path returned by the upstream search tool. All other commands, arguments, streams, cancellation and working-directory semantics stay with the SSH provider. Missing remote rg fails initialization instead of silently executing locally.
- `./spill` implements `SpillStore` through the mounted filesystem. Complete output is atomically created under the workspace's `.agent-output` directory, with a hashed session namespace and collision-resistant filename. Remote failures propagate; no host filesystem fallback exists. The underlying SSH filesystem creates new files with mode 0600.

The Workbench profile also selects the sandbox's Node and preinstalled PTC bootstrap. Deployment must provision these files inside each sandbox. File paths in configuration are POSIX sandbox paths, even when development runs on Windows.

Output files persist with the workspace. This plugin does not delete historical output; workspace lifecycle management owns retention. Session records, credentials and attachment caches remain host service data.

Run the focused tests with `pnpm exec vitest run packages/workbench-sandbox-runtime/test/runtime.test.js` in an isolated checkout. Live acceptance must exercise both search tools, remote write/edit/read, spill readback and search, PTC execution, and absence of those user files in the host filesystem.
