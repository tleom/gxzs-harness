# GXZS sandbox manager

This directory is the runtime owner of per-user sandbox lifecycle and the fixed-workspace file, skill, personal MCP, environment and Office-preview safety rules used by the DSH workbench.

The service is deployed independently from the legacy Dify stack. Its HTTP surface remains private and bearer-authenticated. DSH hosts receive one platform-assigned workspace UUID and cannot choose another workspace through browser payloads.

During migration, the copy under the legacy agent repository remains only to support old workbench export and rollback. After migration acceptance, build and deploy this directory's Dockerfile and remove the legacy stack.

Validation uses the POSIX suites mirrored under `services/sandbox-manager/tests`; production rollout additionally requires the live helper, Landlock, network, file manifest and MCP authorization checks documented under `docs/`.
