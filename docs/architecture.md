# Target architecture

## Decision

DeepSeek Harness replaces the custom Dify Agent runtime. Upstream `@deepseek-ai/*` source is never patched or forked; integration uses a DSH profile and separately versioned gxzs plugins.

Dify may remain temporarily behind a tenant-aware knowledge MCP server. It must not own the agent loop, conversations, run state, tools, personal MCP, files, identity or workbench control. The long-term knowledge boundary is a protocol boundary, so the Dify implementation can later be replaced without changing the agent kernel.

The Java module is `gxzs-ai`; it owns the public workbench gateway, DSH host/session index and platform capability boundary. Production sources have no Dify upstream HTTP client or migration route. Legacy `org.dromara.dify` package names remain naming debt only and do not create a runtime Dify dependency. The verified old Dify data is retained solely as an operational rollback source until cutover acceptance.

## Ownership

| Owner | Responsibilities |
| --- | --- |
| DSH | Agent loop, native tool calling, session event log, prompts, plan mode, goals, todos, compaction, subagents and sandbox capability seams |
| Workbench adapter | Authenticated workbench compatibility API, run projection, SSE journal, human-input bridge, followup/control/resource mapping and durable SQLite state |
| Platform services | Account and tenant identity, assertion signing, per-user host orchestration, credentials, quotas, audit, OSS, file sharing, Office preview, speech transcription and MCP OAuth callbacks |
| MCP layers | Administrator-published read-only global MCP servers plus user-owned personal MCP servers; both load through DSH mcp-client while credentials remain platform-managed |
| Knowledge MCP | Tenant-authorized knowledge catalog, search, citations and document retrieval only |

## Security boundary

The Java gateway remains the public entry point. It signs the method, target, body, content type and SSE cursor in `X-GXZS-Assertion`. The adapter must verify that assertion before routing and derive the owner from it; user identity is never accepted from a request body or query string.

Each user receives an isolated DSH host and `$DSH_HOME`. The product exposes no permission-mode selector: the profile defaults to `danger-full-access`, so tool calls do not wait for per-operation approval. This authority is confined to the user's remote sandbox and fixed-workspace capabilities; host control-plane access, cross-owner access, platform credentials and manager routing remain denied by architecture. The host starts with an immutable `GXZS_HOST_OWNER_ID=<tenant_id>:<user_id>` and rejects an otherwise-valid assertion for any other owner before route execution. Platform data also records `tenant_id/user_id -> host -> DSH session -> workbench chat/run`. SQLite is the local durable projection, not the global account index.

## Persistence

Existing Dify workbench data is migrated through bounded, owner-scoped bundles rather than queried online by the new runtime. The importer preserves old chat/run ids in the adapter, creates deterministic DSH session ids, replays user/assistant text into DSH history, imports UI journal events, and records each source bundle digest for idempotent retries. User files remain in the same sandbox-manager workspace UUID; migration verifies the complete tree version, file count, total bytes and sample SHA-256 values before importing a batch. Old tables remain the rollback source until cutover verification and retention approval.

Unsupported adapter schema versions fail startup. Deployment provisions the approved schema and runs the explicit migration instead of silently altering previous validation databases.

The adapter uses SQLite with WAL, full synchronous writes, foreign keys and transactional event sequence allocation. A run event and its cursor are committed atomically. Request keys are unique per owner and chat. Active runs found on process startup are marked interrupted; they are never silently reported as running. A waiting in-process DSH promise cannot survive process death, so its persisted panel is closed as aborted during recovery rather than pretending the turn can resume.

## Migration order

1. Installable profile, lockfile, CI and contract tests.
2. Assertion verification, owner routing and core chat/run/SSE contracts.
3. Human input and crash semantics.
4. Followup and control projections.
5. Skills, personal MCP and platform resource metadata.
6. Complete file capability, with preview/share/transcription delegated to platform services.
7. Tenant gray release, rollback switch and removal of the custom Dify Agent runtime.

Knowledge MCP catalog/search/citations is intentionally deferred. The boundary remains reserved, but the current runtime performs no knowledge service calls.

## Office preview decision

The current platform preview remains authoritative for the migration. It converts only supplied bytes inside a disposable offline container with no user volumes or network, enforces the existing 20 MiB product contract, protects OOXML expansion, applies the established Word exact-line-spacing compatibility fix, and retains the current Redis cache and Chinese error behavior. DSH `office-to-pdf` is broader and has strong queue/cache/cancellation bounds, but it runs in the DSH host, needs the separately packaged LibreOffice kit, uses different default 50/100 MiB limits, and would require moving remote sandbox bytes into the host. Replacing the platform service requires a separate fidelity, memory, font, isolation and failure-contract benchmark; the adapter should proxy the platform preview endpoint until that evidence exists.
