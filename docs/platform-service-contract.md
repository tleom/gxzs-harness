# Platform workbench service contract

The adapter platform client and the Java fixed-route proxy for preview, sharing and audio are implemented locally. MCP catalog/call and OAuth platform services remain pending.

## Trust boundary

The service listens only on the internal control network. It requires `Authorization: Bearer <owner-derived token>` and `X-GXZS-Owner: <tenant_id>:<user_id>`. The Java service stores only `GXZS_PLATFORM_INTERNAL_KEY`; orchestration derives the host token as HMAC-SHA256 over `gxzs-dsh-platform:<owner>` and injects it as `GXZS_PLATFORM_INTERNAL_TOKEN`. It does not accept browser authentication, forwarded host URLs, tenant/user query parameters or arbitrary downstream paths.

The token authenticates the per-user DSH host. The service parses the owner header, verifies that the host generation currently owns that user in the global host index, and derives all database/storage identities from that owner. A stale host generation or mismatched workspace is forbidden.

## Fixed routes

Base path: `/internal/workbench`.

- `GET /files/preview?path=...`
- `POST /files/preview` with the existing `{name,data}` JSON body
- `GET|POST|DELETE /files/shares`
- `POST /audio` with the original multipart body
- `GET /mcp/catalog` returns the owner-authorized global and personal MCP tool descriptors
- `POST /mcp/call` executes one frozen tool revision for one active run

The adapter client rejects every other route before network I/O and refuses redirects.

## Behavior ownership

Office preview continues to use the existing disposable offline converter, 20 MiB limits, OOXML expansion guards, line-spacing compatibility and Redis cache. Sharing continues to use revocable owner-scoped tokens. Audio continues to use the existing provider and upload bounds. The internal controller delegates to those existing services after reconstructing tenant/account identity; it does not duplicate their business logic.

Responses preserve the existing public workbench payloads. Binary preview responses pass `Content-Type`; downloads/shares may pass `Content-Disposition` and `ETag`. All responses are private/no-store. Error bodies contain a user-safe `message`, never upstream diagnostics or credentials.

## MCP credential and OAuth ownership

The MCP catalog merges administrator-published global servers and user-owned personal servers after owner authorization. Each descriptor contains a stable resource id, DSH runtime name, scope, server/tool ids, JSON input schema, config version and manifest version. It never includes headers, environment values, access tokens or refresh tokens.

A call must match the active run's frozen resource id/version/manifest tuple and host generation. The platform rechecks the global publication or personal ownership immediately before dispatch. OAuth authorization code exchange, refresh, rotation and revocation are platform responsibilities; callback state binds owner, server, host generation and a one-time nonce. The DSH host receives only the final MCP result and cannot read stored credentials. Global and personal tools use the same call endpoint but retain distinct resource ids and audit subjects.

## Deployment

`GXZS_PLATFORM_INTERNAL_URL` and the owner-derived `GXZS_PLATFORM_INTERNAL_TOKEN` are host environment values. The Java platform keeps `GXZS_PLATFORM_INTERNAL_KEY`; the master key is never installed in a DSH host. These values are absent from profile files, adapter responses and sandboxes. Current code accepts one active master key, so rotation requires coordinated host token replacement and a bounded drain; dual-key overlap remains future work. Requests and audit logs record owner, host generation, operation, result and duration, not request bodies or file bytes.
