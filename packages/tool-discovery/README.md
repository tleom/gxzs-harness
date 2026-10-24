# DSH tool discovery

`@gxzs/dsh-tool-discovery` is a DSH 0.2.1-rc.2 plugin. It registers the native
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

- Initial prompt: Markdown plugin summaries inside `<available_plugins>` in a
  native user `system-reminder`, followed by usage rules, matching the skill
  catalog structure. Each available, authorized plugin has its name, display name,
  full description and tool count. Unavailable or unauthorized plugins and their
  diagnostic status lines are omitted. Summaries refresh after visible changes
  or when no longer visible after compaction; internal IDs and scopes stay host-side.
- `mcp({})`: list the same available, authorized plugins as the session summaries.
  An available plugin with an empty tool directory has a count of zero.
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
- Request consistency compares this Agent's loaded definitions and authority,
  not the entire inventory revision or unloaded-tool mask. Unrelated plugin
  refreshes do not abort native work. Preview assemblies cannot replace the
  native request's snapshot; changed loaded definitions or authorization still
  block that step before it reaches the provider.
- Restore: intersect persisted hints with current authorization, exact definitions
  and current visibility. A different authority starts without loaded tools.

Native function calling and PTC share this lifecycle. Newly found tools cannot
be called in the same tool-call batch or the same `run_code` execution. Native
tools outside `managedNames` remain available, including later registrations.

## Bounds and recovery

Search defaults to 8 matches; `pageSize` is the plugin's search presentation setting.
Plugin summaries, schemas and directory descriptions remain complete. The
manager publishes transport and execution policy; actual model context capacity
still applies. The host receives the complete catalog in one authorized snapshot.

Complete source metadata participates in the definition fingerprint.
`inputSchema` is returned separately only when it differs from
`parameters`, preserving source constraints without duplicating an identical schema.
The complete installed inventory is retained internally after recovery, including
plugins excluded by the run's frozen authorization. Model-facing directories
filter those entries; an explicit call naming an unauthorized plugin still reports
`run_authorization_required` and never grants new capabilities itself.

Use `replace_active: true` with a query to replace the loaded set at the next
successful step boundary. That discovery call must be
the only discovery call in the step. Empty/failed searches do not clear the set.

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
failure/cancellation, lifecycle cleanup and 1/50/600/1000-tool payload
measurements. Workbench composition tests cover native continuation, human
answers, Goal and schedule runs, child/job notices, and compaction followed by
JSONL cold recovery or a fork with new authorization.
Model responses and PTC evaluation are controlled fixtures; these tests do not
establish production model quality or token billing.
