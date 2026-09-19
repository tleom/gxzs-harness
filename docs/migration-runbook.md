# Existing workbench migration runbook

The migration is owner-scoped and does not make the new runtime depend on old Dify tables after cutover.

## Preconditions

- Drain or pause new writes for the selected owner.
- Resolve the platform owner to exactly one sandbox workspace UUID and DSH host.
- Provision a fresh schema-3 adapter database and a fresh DSH home.
- Set a one-time `GXZS_MIGRATION_TOKEN` on that host; remove it after migration.
- Retain the old database and workspace volumes until rollback approval expires.

## Export

The old API service exposes `services.workbench.migration.export_bundle(...)` for an operator-owned command or job. Export pages contain at most 20 chats. Use a unique source id per owner/page, for example `<owner>:<cutover-id>:<offset>`.

Each bundle contains:

- owner and source id;
- chat metadata, current selection and non-discarded runs;
- durable run events;
- the existing workspace UUID;
- complete workspace tree version, file count and total bytes;
- up to 20 deterministic sample file SHA-256 records.

Store bundles in an access-controlled migration directory. They may contain user prompts and assistant answers. Do not write credentials, knowledge-base data or raw file bytes into bundles.

## Import

Send each bundle directly to its owner-bound DSH host:

- method: `POST`;
- path: `/ai/workbench/migration/import`;
- ordinary one-use `X-GXZS-Assertion` bound to the exact request;
- `X-GXZS-Migration-Token` with the one-time host migration token;
- JSON body: one export bundle.

The route is not allowed by the normal Java browser gateway. Import validates owner, workspace UUID, tree version/count/bytes and sample hashes before creating any chat. It preserves old chat/run ids, creates deterministic `session-<old-chat-id>` DSH sessions, replays user and assistant text, and imports UI journal events.

A repeated source id with the same SHA-256 returns its prior report. Reusing the source id with changed content returns 409. A pre-existing nonempty deterministic session without an adapter mapping is treated as an interrupted partial import and requires operator cleanup; the importer does not duplicate its history.

## Verification

Before enabling DSH routing, run the deterministic report verifier for every page:

```bash
node "$HARNESS/scripts/verify-migration.mjs" bundle.json import-report.json
```

It fails unless source id, owner, bundle digest, workspace UUID/tree version/file count/bytes and chat/run/event totals all match. Then compare old export totals to import reports:

- chat and run counts;
- event counts per run;
- title, pin and selection samples;
- user question and final assistant text samples;
- workspace UUID, tree version, file count and total bytes;
- every exported sample file SHA-256.

Open representative old chats in the existing Vue UI and verify transcript, tool cards, attachments and file previews. Send a new message in a migrated chat and verify the model receives the replayed history.

## Cutover and rollback

Only new requests switch to DSH after every page for an owner is verified. Keep the old system read-only during the observation window. Rollback routes the owner back to the old kernel and does not merge messages created in DSH automatically; export those new DSH messages separately before any later retry.

After acceptance, delete the one-time migration token. Old tables and volumes follow the approved retention/deletion process; they are not removed by the importer.
