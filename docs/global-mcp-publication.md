# Global MCP publication

Administrators publish global MCP servers through the platform control plane. The DSH host never receives server URLs, OAuth tokens, headers, client secrets or refresh tokens. It receives only the owner-authorized tool catalog from `GET /internal/workbench/mcp/catalog`, and all tool calls return through `POST /internal/workbench/mcp/call`.

A publication record contains an immutable server id, tenant allowlist, display metadata, enabled state, transport policy, credential reference, OAuth registration reference and revision. The platform connects to the server, validates its tool manifest, assigns each tool a stable resource id and runtime name, and publishes a manifest version. User endpoints cannot mutate global records.

The catalog merges allowed global tools and the current user's enabled personal tools. Each descriptor contains only:

- resource id and scope (`global` or `personal`);
- stable DSH runtime name;
- server/tool ids and descriptions;
- input JSON Schema;
- configuration version and manifest version.

The adapter freezes the selected descriptor tuple on run creation. The DSH proxy plugin requires that exact tuple on every call. The platform repeats owner, host-generation, active-run, publication/ownership and revision checks immediately before dispatch. A changed or revoked server fails closed and requires a new run.

OAuth authorization, callback state, code exchange, refresh, rotation and revocation are platform responsibilities. Callback state binds owner, server, redirect URI, the authorization-intent revision and a one-time nonce. Credential-write revisions independently protect refresh results from concurrent revocation or replacement. Audit logs record publication/tool identifiers, owner, run, result and duration without prompts, arguments, credentials or returned file bytes.

Global and personal tools share the proxy transport but retain distinct ids and audit subjects. Global publication supports streamable HTTP and the built-in global-memory transport; its platform egress policy restricts schemes, DNS/IP ranges, redirects and destinations. Personal MCP also supports SSE and stdio inside the owner's Sandbox. Personal stdio uses the owner's configured command, arguments, environment and workspace directory; it does not enforce a platform executable allowlist. Its boundary is the owner's existing Sandbox execution authority, resource limits and scoped process cleanup, not execution in the Host or Manager process.
