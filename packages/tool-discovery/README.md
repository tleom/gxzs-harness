# DSH tool discovery

`@gxzs/dsh-tool-discovery` is a DSH 0.2.1-alpha.2 plugin. It registers the native
`mcp` and `tool_search` capabilities and restricts managed tools per Agent. Original tool
definitions and executors remain registered with DSH; authorization stays with
the host bridge and the original executor.

Run the plugin and the host against **one DSH dependency graph**. In particular,
`Session`, `appendPluginRecord`, ToolRuntime and their Cordis services must resolve
from the same installation. Do not combine a profile's npm-installed Session with
a source-linked plugin that resolves its own workspace pnpm copy. The native
Session API uses JavaScript private fields, so even equal versions in separate
module instances are incompatible. Validate the deployed installation layout as
well as the version pins.

## Host integration

Provide a Cordis service named `toolDiscoveryCatalog` before mounting this plugin:

```js
{
  snapshot(agent) {
    return {
      authorityKey: 'owner-and-current-run-identity',
      revision: 'changes-with-authorization-names-and-definitions',
      ready: true,
      plugins: [{ id, name, displayName, description, preferred, available }],
      tools: [{ id, name, rawName, pluginId, pluginName, pluginCallName, pluginScope,
        description, version, manifestVersion, parameters, inputSchema, outputSchema, annotations, execution }],
    }
  },
  managedNames() { return allCurrentlyRegisteredManagedToolNames },
  subscribe(listener) { return unsubscribe },
  setDiscoveryReady(ready) { /* update the host fallback restriction */ },
}
```

`snapshot` must return only the current Agent's authorized metadata. Names must
come from the complete host catalog, never be recalculated from search results.
The host must reserve `mcp` and `tool_search`. `managedNames` includes unauthorized tools
so discovery never removes the host's authorization restriction. Bridge methods
are synchronous; do network refreshes outside prompt assembly and notify changes.

The GXZS implementation is in `workbench-mcp-tools/src/discovery-catalog.js`.
Its `discovery: true` configuration keeps MCP tools hidden while discovery is
unavailable. The plugin installs its masks before setting readiness, and clears
readiness before releasing them. This protects initialization and hot reload.

## Discovery lifecycle

- Initial prompt: Markdown plugin summaries in a native user `system-reminder`
  message and the two discovery tools. Summaries contain only name, display name,
  full description and tool count. They are refreshed after changes or when no
  longer visible after compaction; internal IDs and scopes stay host-side.
- `mcp({})`: list installed, authorized plugins, including empty or unavailable
  providers. An unavailable provider has an unknown (`null`) tool count.
- `mcp({name})`: all tool names and full descriptions for that plugin, without
  pagination or a 64 KiB result cap. This does not activate any tools.
- `mcp({name, tools: ["first", "second"]})`: exact batch inspection and loading.
  Each entry reports its own outcome; full source schemas and supplied metadata
  are returned. Missing tools do not prevent valid entries from being prepared.
- `tool_search({query, name?})`: search full names, descriptions and parameter
  terms and prepare matching tools. A miss is not proof of absence: use `mcp`
  to inspect the directory and load exact names.
- Successful result: prepare a small set without changing current-step visibility.
- Native `step/end`: validate the finalized durable result, authority, definition
  fingerprint and original turn signal, then replace the Agent's mask.
- Before the next `agent/request`: append the activation hint to native Session
  state through `appendPluginRecord`. An append failure blocks the provider request.
  DSH controls disk flushing; this does not promise fsync before the request. Lost
  hints only require rediscovery. A synchronous system-prompt variable
  refreshes the mask before native schema and PTC SDK generation.
- Restore: intersect persisted hints with current authorization, exact definitions
  and current budgets. A different authority starts without loaded tools.

Native function calling and PTC share this lifecycle. Newly found tools cannot
be called in the same tool-call batch or the same `run_code` execution. Native
tools outside `managedNames` remain available, including later registrations.

## Bounds and recovery

Defaults: 8 matches per search, 64 active tools, 128 KiB active definition budget,
32 KiB per definition, 10,000 indexed tools and 16 MiB index memory budget. Plugin
summaries and directory descriptions are not clipped. Definition limits reject
loading explicitly; they never return a truncated schema. Platform transport,
MCP manifest and model context limits still apply and must report failures.

Activation byte budgets count the callable `name`, `description` and `parameters`.
The full source metadata still counts toward the index budget and definition
fingerprint. `inputSchema` is returned separately only when it differs from
`parameters`, preserving source constraints without duplicating an identical schema.
Installed plugin metadata remains visible after recovery even if the current
run's frozen authorization excludes its tools; discovery reports
`run_authorization_required` and never grants new capabilities itself.

Use `replace_active: true` with a query to replace the loaded set at the next
successful step boundary when its budget is full. That discovery call must be
the only discovery call in the step. Empty/failed searches do not clear the set.
These limits are configurable through the exported `Config` schema.

Plugin names follow `^[a-z][a-z0-9_-]{0,63}$` and are unique in the owner's combined
global/personal catalog. `mcp/plugins` supplies a connection-free name inventory
for create, rename and enable checks. Resource selection protocol 2 sends names;
legacy scoped references are resolved only when unambiguous. Inline mention
positions become name markers in the native prompt, while the displayed query
and localized labels remain unchanged. Plugin names never bypass execution
authorization. Disabled or unavailable providers cannot supply executable tools.

Search indexes and complete schemas stay in host memory. Previous model-visible
tool results remain in conversation history; this plugin does not erase history.

## Validation

The repository's `pnpm check` includes deterministic real DSH AgentLoop tests,
native and PTC dispatch, the GXZS MCP bridge, restore and permission changes,
failure/cancellation, budgets, lifecycle cleanup and 1/50/600/1000-tool payload
measurements. Workbench composition tests cover native continuation, human
answers, Goal and schedule runs, child/job notices, and compaction followed by
JSONL cold recovery or a fork with new authorization.
Model responses and PTC evaluation are controlled fixtures; these tests do not
establish production model quality or token billing.
