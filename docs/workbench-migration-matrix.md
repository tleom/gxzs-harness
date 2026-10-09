# Workbench migration matrix

Public prefix: `/ai/workbench`. Priority: P0 is required for traffic switch, P1 preserves the core current experience, P2 is an auxiliary platform feature.

| Method and path | Domain | Target owner | Priority | Required semantics |
| --- | --- | --- | --- | --- |
| GET `/identity` | Identity | Platform service | P0 | Verified assertion, real user and tenant workspace |
| GET `/catalog` | Catalog | Adapter + knowledge MCP | P0 | Capability flags and tenant-filtered models/tools/skills/knowledge |
| GET `/models/parameters` | Models | Adapter | P1 | Route-specific schema, defaults and 404 |
| GET `/chats` | Conversations | Adapter | P0 | Owner isolation, update ordering and live-state flags |
| POST `/chats` | Conversations | Adapter | P0 | Create DSH session and durable mapping |
| GET `/chats/{chat_id}` | Conversations | Adapter | P0 | Runs, selection, owner and version |
| GET `/chats/{chat_id}/history` | Conversation history | Native SessionController + adapter display projection | P1 | Owner-scoped native backwards pages; fixed opening cursor; standard 50-message/two-turn target and 500-message ceiling; `native=1` keeps active runs bounded and restores live content through native follow |
| GET `/chats/{chat_id}/events` | Native conversation stream | Native SessionController.follow + native assistant publication fold | P1 | Owner-scoped bounded snapshot, unfinished-output baseline and continuous native events; business run mapping and plugin labels remain thin display projections; disconnect aborts the native follower |
| PATCH `/chats/{chat_id}` | Conversations | Adapter | P1 | Rename/pin and DSH title sync |
| DELETE `/chats/{chat_id}` | Conversations | Adapter + retention service | P1 | Session disposal and retention policy |
| POST `/chats/draft/audio` | Speech | Platform service | P2 | Multipart limits and transcription |
| POST `/chats/{chat_id}/audio` | Speech | Platform service | P2 | Owner check and transcription |
| PUT `/chats/{chat_id}/config` | Configuration | Adapter | P0 | Version CAS and immutable selection revision |
| POST `/chats/{chat_id}/runs` | Runs | Adapter | P0 | Request-key idempotency, queue, continuation, attachments and mentions |
| GET `/runs/{run_id}` | Runs | Adapter | P0 | Durable snapshot and owner check |
| GET `/runs/{run_id}/events` | SSE | Adapter | P0 | Last-Event-ID precedence, monotonic replay, heartbeat and terminal close; native-history clients retain business state events while native follow owns conversation content |
| POST `/runs/{run_id}/stop` | Runs | Adapter | P0 | Targeted, idempotent cancellation |
| POST `/runs/{run_id}/resume` | Human input | Adapter | P0 | First answer wins and request-id idempotency |
| POST `/runs/{run_id}/input-interaction` | Human input | Adapter | P0 | Cancel authoritative deadline |
| POST `/runs/{run_id}/input-timeout` | Human input | Adapter | P0 | Server deadline and idempotency |
| POST `/runs/{run_id}/input-skip` | Human input | Adapter | P0 | ASK_CANCELLED and durable history |
| GET `/chats/{chat_id}/followups` | Followup | Adapter | P1 | Tracked queue snapshot without terminal regression |
| DELETE `/runs/{run_id}/queue` | Followup | Adapter | P1 | Queued-only discard and recoverable draft |
| POST `/runs/{run_id}/steer` | Followup | Adapter | P1 | DSH steer mode and active target validation |
| POST `/runs/{run_id}/input-supplement` | Followup | Adapter | P1 | Derived run and supplement lineage |
| POST `/runs/{run_id}/feedbacks` | Feedback | Platform service | P1 | Like/dislike/null without external telemetry |
| POST `/runs/{run_id}/fork` | Fork conversation | Adapter | P1 | Idempotent new conversation with model and display history through the selected answer |
| GET `/files` | Files | Adapter fs seam | P0 | Confined list and stable metadata |
| POST `/files` | Files | Adapter + fixed-workspace manager capability | P0/P1 | Binary upload, version CAS and atomic write; validated with disposable real manager/sandbox; production rollout pending |
| DELETE `/files` | Files | Adapter + fixed-workspace manager capability | P1 | Confined versioned deletion; validated with disposable real manager/sandbox; production rollout pending |
| GET `/files/stat` | Files | Adapter fs seam | P0 | Size, kind, version and downloadable flag |
| POST `/files/directories` | Files | Adapter + fixed-workspace manager capability | P1 | Confined atomic mkdir; validated with disposable real manager/sandbox; production rollout pending |
| GET `/files/text` | Files | Adapter fs seam | P1 | UTF-8 text <=2 MiB and version |
| GET `/files/download` | Files | Adapter or platform streaming | P0 | Binary stream, ETag, filename and size bound |
| GET `/files/links` | File delivery | Platform service | P1 | Owner-scoped signed preview/download URLs |
| GET `/files/preview` | Office preview | Native OfficeToPdf + owner sandbox file seam | P1 | Supported remote Office files use the native converter and cache; owner-confined reads and cancellation; other formats retain platform handling |
| POST `/files/preview` | Office preview | Existing platform service | P1 | Local attachment bytes retain the platform converter and its limits; no sandbox file exists to pass to the remote-file path |
| GET `/files/shares` | Sharing | Platform service | P2 | Current active share |
| POST `/files/shares` | Sharing | Platform service | P2 | Revocable audited token |
| DELETE `/files/shares` | Sharing | Platform service | P2 | Immediate idempotent revocation |
| GET `/chats/{chat_id}/control` | Control | Adapter | P1 | Monotonic goal/plan/todo/compaction projection |
| POST `/chats/{chat_id}/todos/clear` | Control | Adapter | P1 | Request key and revision CAS |
| POST `/chats/{chat_id}/commands` | Control | Adapter | P1 | Goal/plan/compact commands and optional run |
| GET `/resources` | Resources | Adapter + platform metadata | P1 | Personal/global skill, MCP, memory and knowledge catalog |
| POST `/resources` | Resources | Adapter + platform service | P1/P2 | Versioned skill/MCP mutations without sandbox credentials |

## Internal Agent interfaces

| Existing interface | Replacement |
| --- | --- |
| `/inner/api/agent/workbench/plan/inspect` | DSH read-only sandbox and native read/search tools |
| `/inner/api/agent/workbench/control` | DSH goal/plan/todo/compaction tools and adapter projection |
| `/inner/api/agent/workbench/followups` | DSH queue/steer prompt modes |
| `/inner/api/agent/workbench/resources` | DSH skill roots plus platform metadata |
| `/inner/api/agent/workbench/memory` | Adapter/platform memory owner |
| `/inner/api/agent/workbench/mcp` | DSH MCP client with platform credential proxy |
| `/inner/api/agent/workbench/mcp/authorize` | Platform OAuth/approval service |
| `/inner/api/agent/workbench/files` | Adapter fs and deliverables |
| `/inner/api/agent/workbench/files/preview` | Platform signed links and preview service |
| `/inner/api/agent/llm/invoke` | DSH LLM providers |
| `/inner/api/agent/tools/invoke` | DSH plugins or MCP; knowledge tools specifically use knowledge MCP |
| Agent file upload/download requests | Platform file service and DSH attachment seam |

## Knowledge MCP boundary

The knowledge MCP owns only catalog, search, citation metadata and authorized document retrieval. It never owns chat/run state, general tools, skills, personal MCP, files, identity, plan/control or credentials. Dify is an implementation behind this boundary during migration, not a runtime dependency of the new Agent kernel.
