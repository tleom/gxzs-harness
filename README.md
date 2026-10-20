# gxzs Harness

`gxzs-harness` provides the GXZS Agent runtime on DeepSeek Harness. The Workbench profile uses DSH `0.2.1-rc.2`, with exact dependency versions recorded in its manifest and lockfile. Version-guarded preparation scripts and compatibility patches, their validation entry points, and removal criteria are listed in the [DSH preparation register](docs/dsh-preparation-register.md).

## Product boundary

- DSH owns the agent loop, sessions, tools, sandbox execution, planning, goals, compaction and subagents.
- This repository owns authenticated HTTP/SSE compatibility, durable workbench projections, tenant routing and platform integrations.
- Dify is not a second agent runtime. During migration it may remain only as a knowledge-base service exposed through a tenant-aware MCP server.
- Platform services continue to own identity, authorization, file sharing, Office preview, speech transcription, quotas and audit.

See `docs/architecture.md` and `docs/workbench-migration-matrix.md` before adding a route. Knowledge-base integration is currently deferred; runtime knowledge catalogs are empty.

Persistence uses Node's built-in `node:sqlite` with WAL and full synchronous transactions. The API is experimental on Node 22; verified locally on Node 22.23.2. No native addon compilation is required.

Personal prompts are stored by the backend in `gxzs_agent_prompt` and included in the authenticated owner's `workbench/config` response. The adapter reads them at each model step and turns a preferred form of address, background, answer preference and custom instructions into literal, required DSH user context, including for complete-prompt presets, scheduled turns and local child agents. Only filled fields contribute text; the default answer preference contributes nothing. Deploy the backend migration and API before this adapter; older backends without `user_preferences` continue to work. Platform instructions remain system-prompt sections.

## Commands

```bash
pnpm install --frozen-lockfile
npm ci --prefix profiles/workbench --no-audit --no-fund
pnpm check
pnpm check:config
```

`pnpm check:config` performs a real DSH `--dump-config` check and therefore requires the profile dependencies installed from the lockfile.

The native lifecycle integration tests also load the locked DSH profile and use a local fake model. Linux manager/MCP tests and all three image builds run separately in CI. The [CI guide](docs/ci.md) describes the verification gates, documentation-only path and image caches. See `docs/repair-contract-20260922.md` for the current cross-repository protocol and `services/sandbox/README.md` for the sandbox build source.
