# Host orchestration and rollout contract

This document is an implementation contract, not evidence that the platform orchestrator exists.

## Per-user host identity

The platform index owns one active record per `(tenant_id, user_id, kernel)`:

- immutable owner id `<tenant_id>:<user_id>`;
- host instance id and runtime generation;
- `$DSH_HOME` volume identity;
- sandbox workspace UUID;
- image/profile digest and DSH version;
- lifecycle: provisioning, ready, draining, stopped, failed;
- heartbeat, last activity, memory and active-run count;
- rollout cohort and rollback target.

A host starts only when all identities agree: assertion owner, `GXZS_HOST_OWNER_ID`, index owner, workspace UUID and sandbox container labels. A mismatch is a hard failure, never a new workspace allocation.

## Session index

The global index maps adapter chat/run ids to owner, host generation, DSH session id, parent session/run lineage, state and local SQLite generation. The adapter SQLite remains the durable local projection; the global index is routing and compliance metadata, not a second event journal.

Writes use owner-scoped compare-and-swap. A host generation may create/update only its own rows. A stale generation cannot claim a session after replacement.

## Host API

The Java gateway resolves the authenticated owner, selects the configured kernel and asks the orchestrator for a ready host. It never accepts a host URL from the browser. The orchestrator returns an internal endpoint plus generation; the gateway signs the exact upstream request and records the generation used.

Required operations:

- ensure owner host;
- mark/drain/stop/recreate host;
- register chat/session/run mapping;
- heartbeat and capacity report;
- list active runs before drain;
- compliance delete/export for one owner;
- health/readiness separate from liveness.

## Gray release

Routing order:

1. explicit user override;
2. tenant override;
3. percentage cohort based on stable owner hash;
4. default kernel.

A chat pins its kernel and host generation at creation. Existing chats never switch kernels mid-history. Because this implementation migrates no old conversations, only new chats enter DSH cohorts.

Rollback disables new DSH chat creation, drains active DSH runs and routes new chats to the previous kernel. It does not reinterpret DSH sessions as Dify conversations. Local DSH data remains available for export/delete according to retention policy.

## Readiness gates

Before increasing a cohort:

- profile digest and DSH version match the approved release;
- helper hash and sandbox enforcement probe pass;
- model route and function calling probe pass;
- assertion replay/owner mismatch tests pass;
- SSE reconnect, human input and queue/control smoke pass;
- manager binary upload/version/delete smoke pass;
- no telemetry egress;
- error rate, run latency, queue latency, memory and host restart rate remain within thresholds.

## Load tests

Run isolated workloads for cold host startup, concurrent owners, multiple chats per owner, long SSE journals, 20 MiB uploads, human-input waits, queue/steer bursts, compaction, subagents and host restart. Measure host RSS, sandbox RSS, SQLite write latency, event replay latency, manager queue wait and model tokens. Include cancellation and client disconnect storms.

## Security validation

- cross-owner signed requests return 403 before any file/skill/model call;
- stale host generations cannot write the global index;
- sandbox cannot reach the DSH control-plane listener;
- workspace UUID cannot be chosen by browser payload;
- manager/platform tokens never enter sandbox or adapter responses;
- SSH host keys are pinned and per-user authorization keys are rotated;
- symlink, archive expansion, path traversal and version-race tests pass;
- MCP credentials are platform-managed and OAuth callbacks bind state to owner/server/host generation;
- audit records contain identifiers and outcomes, not prompts, secrets or file bytes.
