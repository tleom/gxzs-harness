# 2026-09-22 跨仓修复契约

本轮以当前 frontend、backend、harness 工作区为准。DSH 保留原生 AgentLoop、Session、inbox、Goal driver；harness 负责平台身份、执行准入、持久投影、资源冻结和传输。修改源码不表示已发布或部署。

## 任务身份与生命周期

- 同一个 `request_key` 始终返回最初创建的 run，包括 failed；不能把它复活为 queued。显式原文重试使用新 key 和 `retry_of`，得到新 run，旧 run 作为 parent。普通新消息的 `parent_run_id` 仅表示关联，不改变消息内容。
- `steer` 的最后一步同步核对目标当前原生 turn、running 状态和有效 admission，再调用原生 inbox。失效返回 HTTP 409 / `STALE_RUN`，原队列保留。
- Goal 自动轮次经过原生 `agent/pre-step` 的相同准入；一个业务 run 可关联多个原生 turn，事件游标持续递增。冻结工具集合不随全局 catalog 的刷新扩大。
- 重启先对账原生 session 日志和 inbox，避免只把投影改成 interrupted 后让原生消息继续无准入执行。`health` 返回 `live`、`ready`、`recovery`、`resources`；非 ready 可返回 503，manager 必须解析 body 中的 liveness。
- SSE 以数据库为事件队列，按页发送并尊重 `write(false)`/`drain`，慢连接超时关闭后仍可从游标重放。
- 流式 delta 按 20ms 或 64KiB 有界批写，保留原始事件和连续游标，`FULL` 事务提交后才发布；原生事件、读取、终态和关闭前 flush。恢复从原生最终消息重建未提交尾批，避免丢字或重复。

## 凭据

manager owner token：

```text
base64url-no-padding(HMAC-SHA256(rootManagerToken UTF-8,
  "manager\n" + owner + "\n" + workspace + "\n" + generation + "\n" + instance))
```

每次请求携带 `x-gxzs-owner`、`x-gxzs-host-generation`、`x-gxzs-host-instance`，且 URL workspace 必须与持久 host 记录一致。owner 凭据只能调用其白名单能力；编排、换代和全局资源管理保留 root 凭据。

host assertion key：

```text
base64(HMAC-SHA256(base64-decode(rootAssertionKey),
  "assertion\n" + owner + "\n" + generation + "\n" + instance))
```

Java ensure/replace 提交的是 root assertion key，manager 只向 host 下发派生 key；Java 签名用同一个派生 key，避免双重派生。全局 root 只存 Java/manager。

## MCP

- `binding_id` 为纯 run UUID。授权 callback 外层是 `{authorization: grant, action: 'validate' | 'consume'}`；validate 可重复且实时核对权限，consume 在派发前只消费一次 nonce。
- grant 签名覆盖 owner/workspace/run/request/resource、version/manifest_version/runtime_version、arguments、deadline_ms 等业务内容。manager 对参数进行类型敏感比较，不能将 `true` 与 `1` 混为相同参数。
- 个人工具的 runtime_version 等于 version；全局记忆的 runtime_version 对应镜像内固定记忆引擎，平台资源 version 独立用于授权。
- `request_key` 用于关联执行与授权，不作为去重或调用次数限制。AI 可以自行再次调用同一工具；新的授权 nonce 仍须单独验证和消费。平台只持久保存尚未确认的外部调用状态，用于停止时提示可能的副作用，不缓存结果、不自动重放，也不因未知结果自动替 AI 重试。
- `deadline_ms` 是最多 350 秒的绝对 Unix 毫秒截止时间，各层仅消耗剩余预算。manifest 或 schema/description 变化会刷新工具。完整 catalog 不可用时返回失败，不能把局部成功当作完整目录。
- 用户停止由平台 `POST /internal/workbench/mcp/cancel {run_id}` 集中处理（`mcp/stop-run` 为同义兼容入口）：Java 写取消标记、取消全局 HTTP，并调用 root manager `stop-binding {binding_id}` 等待执行终止确认。客户端断线本身不停止任务。外部已产生的副作用不可回滚，结果保留 uncertain。
- `stop_confirmation: {fenced, uncertain}` 经 SQLite、GET DTO 和 `workbench_stop_confirmation` 事件保持一致。`fenced` 表示已确认执行隔离；`uncertain` 合并全局 HTTP、个人 MCP、global-memory 账本及仍未结算的原生工具调用。纯文本、未派发和结果已知的调用不误报；未知结果在重复停止、重启及归档后继续保留，不能据此自动重试。

## 主机换代

`POST /sandboxes/{workspace}/replace-host` 仅允许 root。请求包含 ensure 的字段及 `expected_generation`、`expected_instance_id`；新 generation 必须为 expected+1，instance 必须不同。

活跃任务期间返回旧 generation、`state:draining`、`ready:false`，持续续约和心跳，只拒绝新 acquire。停 host 和 sandbox 后才 fence；随后复用持久 `home_volume`，创建新代次。响应携带 replacement 的前后身份，Java 依据它做 CAS。fencing 期间拒绝业务调用。

首次 provisioning 在等待 catalog 前登记并上报，健康等待不能持有 workspace 锁。维护线程在锁外探活，在锁内重新核对代次和状态后更新 ready。

## Office 与验证

预览统一支持 doc/docx/docm/dotx/dotm/odt/rtf；输入与 PDF 各 20 MiB，转换预算 45 秒。更广的沙箱文档生成能力不等于预览 API 已支持全部格式。

CI 包括 JS 单测与真实 DSH fake-LLM 组合、Python manager 与真实 Linux MCP transport、固定记忆引擎、三个镜像构建和容器 Office/SSH 检查。部署前还须使用目标环境完成真实 owner 冷启动、停止、失租和换代恢复验证。数据库迁移、凭据轮换、发布和部署均有各自的授权边界。
