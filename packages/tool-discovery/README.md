# DSH tool discovery

`@gxzs/dsh-tool-discovery` is a DSH 0.2.1-alpha.2 plugin. It registers the native
`tool_search` capability and restricts managed tools per Agent. Original tool
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
      plugins: [{ id, name, callName, scope, description, preferred }],
      tools: [{ id, name, pluginId, pluginName, pluginCallName, pluginScope,
        description, version, manifestVersion, parameters, outputSchema }],
    }
  },
  managedNames() { return allCurrentlyRegisteredManagedToolNames },
  subscribe(listener) { return unsubscribe },
  setDiscoveryReady(ready) { /* update the host fallback restriction */ },
}
```

`snapshot` must return only the current Agent's authorized metadata. Names must
come from the complete host catalog, never be recalculated from search results.
The host must reserve `tool_search`. `managedNames` includes unauthorized tools
so discovery never removes the host's authorization restriction. Bridge methods
are synchronous; do network refreshes outside prompt assembly and notify changes.

The GXZS implementation is in `workbench-mcp-tools/src/discovery-catalog.js`.
Its `discovery: true` configuration keeps MCP tools hidden while discovery is
unavailable. The plugin installs its masks before setting readiness, and clears
readiness before releasing them. This protects initialization and hot reload.

## Discovery lifecycle

- Initial prompt: bounded plugin summaries and one search tool.
- Query: keyword search, exact tool ID/name, optional `plugin_id`, and bounded
  pagination. A plugin-only query lists capabilities without loading all tools.
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

Defaults: 8 matches per page, 64 active tools, 128 KiB active definition budget,
32 KiB per definition, 8 KiB search result, 4 KiB plugin summary. Schemas are never
truncated. Unsupported large definitions return an explicit reason.

Use `replace_active: true` with a query to replace the loaded set at the next
successful step boundary when its budget is full. That discovery call must be
the only discovery call in the step. Empty/failed searches do not clear the set.
These limits are configurable through the exported `Config` schema.

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
