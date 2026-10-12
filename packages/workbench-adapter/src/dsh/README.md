# DSH assistant presentation

`client-assistant-stream.js` is the published JavaScript from
`@deepseek-ai/dsh-api-session-controller@0.2.1-alpha.2`,
`lib/types/client/sessions/assistant-stream.js` (MIT; see LICENSE).
Only the unavailable source-map reference is removed; executable code is unchanged.

The class is not exported by the package's public client entry. Keeping this
small upstream module here avoids importing a private installation path at
runtime or implementing a second settlement state machine. Its public
`@deepseek-ai/dsh-llm/assistant-stream` dependency is pinned with the adapter.
When upgrading DSH, replace this file from the matching published package and
run the native history/presentation tests.
