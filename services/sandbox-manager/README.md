# GXZS sandbox manager

This directory is the runtime owner of per-user sandbox lifecycle and the fixed-workspace file, skill, personal MCP, environment and Office-preview safety rules used by the DSH workbench.

The service is deployed independently from the legacy Dify stack. Its HTTP surface remains private and bearer-authenticated. DSH hosts receive one platform-assigned workspace UUID and cannot choose another workspace through browser payloads.

During migration, the copy under the legacy agent repository remains only to support old workbench export and rollback. After migration acceptance, build and deploy this directory's Dockerfile and remove the legacy stack.

Validation uses the POSIX suites mirrored under `services/sandbox-manager/tests`; production rollout additionally requires the live helper, Landlock, network, file manifest and MCP authorization checks.

## 技能导入

主要上传路径先以 `skill_stage` 将完整包传至 owner 沙箱一次，返回 `import_id`。
adapter 校验 `SKILL.md` 后以 `skill_prepare` 绑定调用名称和当前版本，安装请求仅传
`import_id` 与版本；发布前仍复核清单、全局名称冲突及目标版本。
`skill_import` 快速返回 `running`，客户端通过 `skill_import_status` 查询最终回执。
`skill_import_cancel` 使用现有 MCP Worker/supervisor 的进程停止确认，取消和查询不占普通操作槽位；
后台导入沿用 manager 的操作准入槽位，确认 worker 退出后释放；停止未确认时继续跟踪并重试收尾。
沙箱物理停止已被确认时，生命周期回调同步终止技能任务跟踪并释放槽位，启动中的任务不得继续派发。
连接中断时查询同一回执，不自动重放安装。旧 JSON 和二进制导入接口内部也走暂存、校验、
执行及回执链路，保留原来的同步返回字段；不重复传输整个包做安装前检查。

owner 的 `.skill-imports/<import_id>/` 保存暂存包和发布阶段记录。内容分块落盘、CRC 校验后
原子发布；新旧目录交换前记录 inode 身份，异常退出后由状态查询或技能列表读取触发恢复。
恢复仅处理有记录且未被运行锁占用的导入，识别已发布的新包和待归档旧包；无法确定时返回
`unknown` 并保留相关目录。旧实现遗留且没有阶段记录的暂存目录不会被批量删除。
所有阶段与终态写入共用状态锁，旧取消快照不能覆盖已发布结果。
最终结果区分 `completed`、`cancelled`、`failed`、`conflict`、`unknown`；先持久化结果，
上传数据清理失败单独记录并重试，不影响已确认结果的查询。
维护批次和回收标记写入失败仅产生警告，不阻断已安装技能读取。
24 小时未使用的暂存包在后续技能列表读取时回收，终态回执保留 7 天；
活跃执行及无法确认的发布目录不按年龄删除。待恢复索引避免每次列举遍历全部历史回执，
历史迁移与过期回收最多每 5 分钟触发一次，只读打开不额外执行目录 fsync。

文件数量和 ZIP 解压总大小不设固定上限；上传 100 MiB、目录下载 1 GiB、每条消息 20 个附件
以及 `SKILL.md` 64 KiB 保持原有规则，不增加磁盘水位检查。
旧 JSON 入口同样支持 100 MiB 技能包：Java、Host、manager 的技能请求体预算为 140 MiB，
包含 Base64 和 JSON 封装；解码后的上传内容仍校验 100 MiB。其他 JSON 资源操作沿用各自预算。
旧接口与断线恢复统一区分失败、取消、版本冲突和未知结果，已确认终态不会降为未知。
全局包在首次落盘时同步计算摘要，保持原内容地址格式；相同源包使用 root 管理的摘要索引，
命中已发布目录时跳过重复资产解压和落盘，目标目录已移除时重新校验安装。
技能和普通目录 stat 指纹复用同格式增量编码，仍需要收集、排序目录元数据。
前端目录分页不设总条目上限，保留重复游标检查；分页条目追加合并。
暂存包保留每个文件的数据同步，每个完成的目录统一同步一次，发布后同步父目录。
导入发布、编辑、重命名、卸载和发布恢复共用技能目录锁，版本检查与对应修改在同一锁内完成。
异步导入状态查询确认完成后再次使技能目录缓存失效；工作区目录选择也不设总条目上限，保留分页游标检查。
JSON 兼容入口仍整体解析请求，
Base64 解码后的内容分块落盘。因此文件内容的流式处理不代表所有阶段都具有固定内存占用。

## MCP 资源策略

manager 是资源配置的唯一运行时来源。通过部署环境变量 `GXZS_MCP_POLICY`
传入 JSON 对象覆盖 `mcp_policy.py` 的默认值；启动时校验键名、类型、运行时整数与定时器范围。
容量和时长必须为正数。
策略不含凭据。只有 coordinator bearer 能读取 `GET /mcp-policy`；Java 经此接口读取，
并通过已验证 owner 的 `mcp/policy` 发布给 Node，`mcp/catalog` 返回一次完整目录。
策略先进入实际 HTTP 客户端和个人文件管理器，首次发现也使用新预算。
owner 的 `mcp.json` 不能覆盖平台资源策略。
全局静态凭据复用 `request_bytes` 校验保存及解析；请求头按 HTTP token 格式、控制字符和平台身份头规则校验。
配置变更通过更新 manager 环境并重建 manager 生效。Host 刷新目录前显式刷新策略；
Java 和 Node 保留最近一次验证通过的资源快照，刷新暂时失败时继续使用该快照。
一次请求的传输和解析使用开始时取得的预算；owner 授权、版本和取消继续实时核对。
普通技能、文件等资源请求使用各自已有预算，不依赖 MCP 策略服务可用。

| 配置键 | 默认值 | 用途 |
| --- | --- | --- |
| `request_bytes` / `response_bytes` | 各 30 MiB | 实际传输消息预算，包含封装 |
| `connect_timeout_seconds` / `initialize_timeout_seconds` / `discovery_timeout_seconds` | 各 60 | 分阶段连接与发现预算 |
| `startup_timeout_seconds` / `catalog_timeout_seconds` | 120 / 180 | 进程启动与目录同步的总预算 |
| `call_timeout_seconds` / `max_call_seconds` | 60 / 350 | 未指定插件超时的默认值，以及调用的总截止时间 |
| `write_timeout_seconds` | 30 | 向 worker 传输请求的等待时间 |
| `control_timeout_seconds` / `control_retry_attempts` | 15 / 3 | 清单管理和授权检查等待，以及明确未派发的管理器忙重试次数 |
| `response_grace_seconds` / `cleanup_timeout_seconds` | 15 / 6 | worker 返回封装宽限与取消后清理批次预算 |
| `outcome_lock_seconds` | 10 | 持久化未知结果标记的 SQLite 锁等待 |
| `supervisor_input_buffer_bytes` / `supervisor_output_buffer_bytes` | 2 / 16 MiB | supervisor 双向转发缓冲水位，达到水位后背压，继续传输完整消息 |
| `cancel_retention_seconds` / `cancellation_check_timeout_seconds` | 600 / 0.5 | 取消标记保留和取消状态查询；保留时间至少覆盖最大调用时长及返回宽限 |
| `receipt_retention_seconds` | 3600 | 已确认进程退出回执保留，至少覆盖进程启动窗口；未确认回执不按年龄删除 |
| `max_active_calls` / `max_owner_calls` / `max_connections` | 64 / 8 / 64 | 总并发、owner 并发及连接容量 |
| `max_idle_connections` / `max_owner_idle_connections` / `idle_seconds` | 32 / 4 / 300 | 仅回收空闲连接 |
| `discovery_parallelism` / `discovery_cache_entries` | 8 / 512 | 发现并行度与缓存容量 |
| `discovery_cache_seconds` / `discovery_failure_seconds` / `refresh_retry_seconds` | 60 / 30 / 30 | 目录缓存与失败重试间隔 |
| `refresh_interval_seconds` / `refresh_failure_seconds` | 30 / 5 | Host 的正常目录刷新和初始化失败重试间隔 |
| `source_archive_bytes` / `source_download_timeout_seconds` | 50 MiB / 120 | 构建固定版本记忆引擎源码时的下载预算 |

示例：`GXZS_MCP_POLICY={"max_call_seconds":900,"startup_timeout_seconds":180,"catalog_timeout_seconds":300}`。
各阶段始终服从当前请求的总截止时间，取消不会延长截止时间，业务调用不会自动重放。
升级顺序为 manager、Java API、Host/Node，全部完成后再放宽额度；回滚时保留 owner 的完整结果文件和原有配置。
`request_bytes` 和 `response_bytes` 分别约束输入、输出，包含实际传输封装。
SSE 使用逐事件预算，普通 HTTP 使用逐响应预算；SDK 和 Java JSON 字符串解析器都接收实际额度。
浏览器的 MCP 管理请求由后端预算定时，取消信号保留；Java→Host、Host 请求读取和管理器 ingress 同步使用策略。

首次获取策略自身不能依赖尚未取得的策略。Java 的引导请求通过 `ai.mcp-policy-bootstrap-timeout`（默认 10s）、
`ai.mcp-policy-max-bytes`（默认 65536）、`ai.mcp-policy-cache-time`（默认 1s，合并显式刷新）配置；
Node 的引导连接使用平台客户端已有 `timeoutMs` / `maxResponseBytes` 配置。这些只用于读取小型策略文档。
策略刷新也使用引导预算，旧的业务响应预算不会阻断配置恢复。每次业务调用使用开始时的策略快照，
已有 Tasks 会话保留创建时的预算；身份、配置版本、授权与取消仍在对应控制点重新核验。
共享 `/resources` 先按通用入口预算读取，超过时才按需获取更大的 MCP 预算；解析 operation 后，
普通资源继续受通用预算约束，MCP 操作使用 MCP 预算，技能操作不依赖 MCP 策略网络读取。

MCP 的配置、工具总数、工具说明和完整清单不设置独立业务规模配额；搜索保留默认返回数，允许显式指定更大的正整数。
MCP 服务器通过协议分页返回工具时，由 SDK 正常取完。完整目录仍须在实际传输预算内，
超出时报告 `MCP_DISCOVERY_TOO_LARGE`，不混用业务执行结果未知的语义。
协议游标循环、类型无效、未授权、配置版本变化等仍返回相应错误。

完整 MCP 结果包含 `structuredContent`，交给 DSH 原生 bridge 校验；展示压缩使用原生 `spill-policy`，
程序返回值保持完整。`SandboxSpillStore` 在 owner 沙盒的 `.agent-output/<session-hash>/` 保存原文；
超长行另生成 `.readable.txt` 阅读副本，提示中给出适合原生 `read` 按行读取的路径。
原文文件保持精确内容。阅读副本失败时返回原文引用及字符范围提取提示；原文保存失败时，
原生策略保留完整行内结果并记录失败，不把成功业务调用改成保存错误。
展示预算沿用原生 `spill-policy.maxInlineTokens`。存储的 `readMaxLineLength` 默认取原生 read 配置，
修改原生 read 的行宽时同步调整；写入等待由 `writeTimeoutMs` 配置。

协议字段、平台调用名、UUID、摘要和进程回执格式仍按原合同校验。IO 分块、队列槽位、取消轮询和内核信号常量
用于背压或进程退出证明，不是工具数量或消息总大小门槛；底层运行时的可寻址内存、定时器和解析栈边界仍适用。
个人 MCP、全局 stdio MCP 和全局记忆共享 manager 的调用准入计数；MCP 连接与待回收对象统一计入连接容量。

全局 stdio 的 HOME/工作区使用按 workspace/server 生成且核对标签的平台私有卷。SDK 目录刷新复用连接，容器重建复用数据；卷不会挂载到用户 Sandbox，也不会随连接自动删除。辅助容器使用 UID 1000、只读镜像、原有资源配置及独立网络，临时挂载显式允许执行并保留 nosuid/nodev，禁用镜像的 SSH 健康探针。

网络锁、Docker 创建及 bootstrap 共用调用截止时间。回收循环在 `cleanup_timeout_seconds` 内交替安排遗留容器发现与已有对象关闭，所有对象沿用同一公平重试队列；未确认关闭时保留容量。Host 的 `mcp_fence_pending` 记录仅表示已有生命周期尚缺资源退出证明，沿原维护入口重试；它不提交新业务任务。supervisor 在存活期非阻塞回收已退出的领养子进程，同时保留主 worker 的退出状态。
Java 全局 HTTP/SSE 的发现、普通调用、内容读取和保留的 Tasks 连接共用 executor 内的连接准入，
同时执行 `max_active_calls`、`max_owner_calls` 和 `max_connections`。等待受请求截止时间、取消及线程中断约束，
连接关闭后释放额度；已有连接上的 Tasks 取消不再申请普通槽位。不同执行进程各自计数，不承诺跨进程总额度。
一次目录组装从同一个发现快照生成工具和插件描述，避免缓存过期时混入不同版本。
已创建的全局 Tasks 复用创建时绑定的目录和原 SDK 会话，并实时校验插件启用状态、配置版本、owner 和执行授权。
控制操作不会因目录缓存过期再次申请发现连接；目录或调用额度已满时，在途查询仍可被原连接上的取消请求打断。
新run的目录刷新实际等待额度时，可复用同owner、同插件及同配置/凭据指纹、未过期任务所绑定的Discovery引用，
使恢复工具仍能沿原生发现与注册链路进入新run。引用随Task关闭释放，不新增持久化缓存；正常有额度时继续访问远端发现。
该回退提供任务创建时已核验的定义，不表示满额期间重新观测到了远端的实时目录。

已知性能边界：Java SDK 2.0.1 使用 JDK 21 的按行解码器读取 HTTP JSON，超长单行会反复扫描。
31 MiB 总响应在分行 JSON 测试中通过，Java 解析器的单个 31 MiB 字符串测试也通过；
完整 SDK 路径的单行 31 MiB 响应在 20 秒诊断测试中未完成。该路径不是独立字节额度，
本轮未修改第三方 SDK/JDK 解析实现，不将其报告为已解决的性能问题。
