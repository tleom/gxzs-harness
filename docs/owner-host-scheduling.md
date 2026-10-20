# 个人宿主与全局任务调度

## 请求链路

首次访问 `/ai/workbench/**` 时，Java 从已验证登录态生成 owner，优先复用仍有有效心跳的宿主，否则调用 manager 的 `ensure-host`。新用户的工作区 UUID 由 owner 稳定派生；已有用户必须保留索引内的原工作区。manager 串行创建个人沙盒、SSH 身份、宿主数据卷，检查健康后 Java 才登记为 ready。

宿主默认工作目录仍按对话隔离在 `/workspace/conversations/<chat-id>`。模型配置来自管理员提供的模板，模板不得从任何用户的完整 DSH_HOME 复制。用户数据不会进入镜像。

任务先保存在用户宿主 SQLite 的 `run_submissions` 中，然后经 owner/generation 身份验证向 manager 申请全局名额。拿到名额才发送到 DSH；同一对话共用一个执行名额，后续消息由 DSH inbox 排队，插队消息与原生子智能体继承该对话的名额，不按消息数或子智能体数计数。

固定限制：每个 owner 最多 3 个运行中的对话，全局最多 10 个运行中的 owner、30 个对话。等待提问回答、计划反馈或批准时释放名额，反馈后先重新申请名额再恢复；完成、失败、已暂停、已停止均不占名额。队列按首次申请顺序选择符合限制的任务，某个用户达到上限不会挡住其他符合条件的用户。停止但尚未确认结束的任务保留名额。manager 的队列持久化在 `/state/admission.sqlite3`，不能部署多个互不共享队列的 manager。

宿主心跳由 manager 检查健康后发送，不能再依赖迁移用户的静态清单。无运行任务且连续 2 小时没有沙盒/调度活动时，Host 和沙盒一起停止，数据卷保留，下次访问唤醒。已经向 SnailJob 确认登记的未来计划可以随环境休眠；距离原生执行时间不足 5 分钟、登记未确认、通知回传未确认、队列/Agent/工具/终端/浏览器仍活跃时继续运行。纯健康探测不延长空闲时间。宿主连续健康失败超过 60 秒时先停止宿主和沙盒，再回收名额。不能单凭心跳过期直接释放运行名额。

创建、名额申请和回收共用工作区锁；受管沙盒不再由旧的独立回收线程停机。创建前先落盘 owner 记录，失败也保留归属。停止宿主和沙盒后发送 stopped 心跳，健康检查按宿主并发执行，防止单个异常账户拖延其他账户的续期。SQLite 名额判断使用显式写事务，保证共享数据库的连接不会同时超额放行；这不代表支持多个 manager 进程同时管理容器，生命周期锁仍要求单实例部署。

## manager 配置

沿用既有 `WORKBENCH_SANDBOX_*` 和 manager token，并配置：

```dotenv
GXZS_HOST_IMAGE=gxzs/dsh-host:<已验证版本>
GXZS_HOST_NETWORK=gxzs-ai-sandboxes
# 必填：manager 不加入每个 owner 的隔离网络，必须通过内网映射端口访问 Host。
GXZS_HOST_BIND_IP=10.16.9.237
GXZS_HOST_ADVERTISE_IP=10.16.9.237
# /state 绑定目录在 Docker 宿主机上的真实绝对路径
WORKBENCH_MANAGER_HOST_STATE=/srv/gxzs/manager-state
GXZS_HOST_MANAGER_URL=http://gxzs-sandbox-manager:5010
GXZS_HOST_PLATFORM_URL=http://gxzs-backend:8080/internal/workbench
GXZS_ORCHESTRATOR_TOKEN=<与 Java 一致的编排 token>
GXZS_SANDBOX_HELPER_HASH=<沙盒镜像 helper.js SHA-256>
GXZS_HOST_SETTINGS_FILE=/config/host-settings.yaml
GXZS_HOST_CREDENTIALS_FILE=/config/host-credentials.yaml
```

settings / credentials 是专门准备的统一模型模板，仅配置已批准的 Qwen 模型；路径挂入 manager，只复制模板文件。签名密钥与按 owner 派生的平台代理 token 通过私有 ensure 请求提供，平台主密钥不会进入宿主。manager 的 `/state` 必须持久化；manager 必须能访问 `GXZS_HOST_ADVERTISE_IP` 上 Docker 动态映射的 Host 端口。缺少 `GXZS_HOST_BIND_IP` 或 `GXZS_HOST_ADVERTISE_IP` 时，manager 拒绝创建 Host。宿主仅在 3081 暴露签名适配 API，原生 DSH API 保持 loopback。跨机器网关使用 Docker 分配并保持的内网映射端口，不把容器 DNS 名称返回给 235。

构建入口：

```sh
docker build -f services/dsh-host/Dockerfile -t gxzs/dsh-host:<版本> .
docker build -t gxzs/harness-sandbox-manager:<版本> services/sandbox-manager
```

## 上线顺序及现有用户

### 日历提醒与计划预唤醒

后端通过 SnailJob 2.0.2 的 `POINT_IN_TIME` / `SnailJobBizIdOpenApi` 登记单次任务，执行器为 `gxzsPointJob`。日历和 Agent 共用登记实现：业务变更事务保存版本和待登记标记，提交后逐条投递；失败仅重试对应业务记录。每条登记保留一个执行时刻后 30 秒的一次性确认超时，正常回调成功后撤销；未确认时仅按该业务主键补偿，补偿失败继续重试这一条。进程启动时一次性分页恢复所有未完成计划，包括已登记但因没有在线客户端被 SnailJob 取消的任务。日历复用发送状态，Agent 使用 `wake_completed` 按版本记录实际唤醒确认。没有周期查询到期业务数据的任务。SnailJob 不可用时，计划尚未确认的 Host 继续运行。

日历 `reminder_at` 按中国标准时间解释，转成 UTC instant 后登记。`snail-job.schedule-zone` 默认 `Asia/Shanghai`，必须与 SnailJob Server 的 JVM 时区一致；Server 使用其他时区时，给后端设置相同的 `snail-job.schedule-zone`，业务时区和原生 DSH IANA 时区不随之改变。不同版本使用不同的确定性业务 ID，旧回调先核对当前版本及发送状态。修改、删除及取消会撤销已知旧任务。

Agent 在启动、原生 `schedule/changed` 事件发生后上报完整计划快照。Java 只保存原生下一次执行的 UTC instant，不重算 daily/weekly/every/cron 规则。唤醒时间固定为原生下一次执行前 5 分钟，已经进入预热窗口时立即走现有 `ensure-host`；不增加预热数量限制。预唤醒绕过 Java 的 ready 心跳缓存，携带 `scheduled_wakeup=true`，由 Manager 在物理停机共用的工作区锁内确认运行状态并续记活动时间；停机已开始时先等待交接，随后恢复容器，未就绪时保留重试。实际消息投递、循环推进和执行历史仍由 DSH 负责，推进下一次计划不等待模型执行结束。完成通知由执行结束事件触发，失败单独重试，恢复依赖现有持久化执行记录。

Host 活动协议 2 区分总计划和已经确认登记、且距离执行超过 5 分钟的计划。Manager 在连续空闲 2 小时后，通过当前 owner 派生凭据调用 `/ai/workbench/lifecycle/sleep`，临时阻止新写入/原生步骤，再核对原生目录、登记回执和未确认通知。交接失败保留运行和健康心跳；未完成停机时 60 秒后自动解除临时屏障。旧协议仍保留所有有效计划，不能把未知或不完整读取当成空闲。

升级顺序：

1. 在批准的数据库维护步骤内，备份 `sys_calendar`、`gxzs_agent_job`、`gxzs_agent_host`，先应用后端 `V20261020_02__agent_job.sql`，再应用 `V20261021_01__point_job_wakeup.sql`。只新增 `gxzs_agent_job` 一张业务表，其他表增加登记字段。DDL 为可重复执行的扩展，回滚旧程序时保留新增列。
2. 先更新 Manager，使其支持 `scheduled_wakeup` 的锁内状态确认，再停用 SnailJob 控制台中旧的 `calendarReminderTask` 周期任务并部署新后端。新执行器自动接收逐条注册；启动时将已有未发送日程一次性登记。过去到期但尚未发送的历史提醒会补发一次，执行迁移前应核对数量。
3. 确认新后端已支持任务通知的 `initialize` / `recover` 动作后，再更新用户 Host 镜像，最后更新前端。旧后端会拒绝这些新动作；旧 Host 的有效计划仍保持常驻，新 Host 必须收到平台登记确认才能休眠。镜像换代继续遵守原有排空和 fencing 协议，不在线重启活跃任务。
4. 验证单次、多选星期、间隔、Cron、时区、改期、删除、登记响应丢失、后台离线唤醒以及完成通知。SnailJob 回调失败保留调度平台的重试/失败记录，实际容量和启动耗时仍需真实环境验证。

回滚时先让 Manager 恢复“有效计划保持常驻”的旧行为，再回滚 Host/后端；日历旧扫描恢复前先停用新日历单次任务，避免两个执行入口重叠。数据库新增列可保留，用户数据卷不变。

先备份 manager 状态、宿主索引和个人数据卷，停止接收新任务并排空已有任务；随后部署 manager、Java 网关，再部署全部用户宿主。旧宿主没有全局调度上报，不能与新调度宿主并行提供不限额执行。

现有迁移宿主的数据目录和名称不会自动接管或重命名。上线时需要将既有工作区、宿主卷及 owner/generation 标签明确迁入受管部署，保留原索引的 workspace；停止旧的固定用户心跳脚本。owner、工作区或镜像标签不一致时拒绝自动覆盖。

上线验收应覆盖：全新账户冷启动、两个旧账户的原文件与历史、同用户第四个对话、全局第 11 位用户／第 31 个对话、队列取消、直接发送、宿主重启与数据卷恢复、manager 重启、等待用户输入期间的名额、跨用户拒绝。

## 共享资源池

在 Docker 宿主机使用 systemd cgroup v2，把 `services/sandbox-manager/systemd/gxzs-workbench.slice` 和 `gxzs-workbench-.slice.d/limits.conf` 安装到 `/etc/systemd/system/`，执行 `systemctl daemon-reload`。全局池限制 15 CPU / 30 GiB，每个工作区 slice 限制 2 CPU / 4 GiB，Host 和 sandbox 的 `CgroupParent` 必须相同。前缀 drop-in 使后续新用户自动继承配额。

manager 配置 `GXZS_OWNER_CGROUP_PREFIX=gxzs-workbench`，并将 `GXZS_HOST_CPUS=2`、`GXZS_HOST_MEMORY=4g`、`WORKBENCH_SANDBOX_CPUS=2`、`WORKBENCH_SANDBOX_MEMORY=4g` 设置为单容器上限；两容器合计仍受 owner slice 限制。MemoryHigh 在 owner 3 GiB / 全局 28 GiB 提前施加回收压力，禁用该池 swap。10 人同时运行时共享全局容量，每人 4 GiB 是弹性上限，不能视为每人保留 4 GiB。变更现有容器的 cgroup parent 需要排空后重建，个人数据卷继续复用。

沙盒的 `WORKBENCH_SANDBOX_PIDS_LIMIT` 默认 1024，可配置为正整数；Linux 的该额度同时计算进程和线程。Chromium 与 Node/SSH 工具共用额度，原来的 256 可导致 `pthread_create` / 辅助进程启动失败。manager 在容器镜像、归属网络、附件卷和 cgroup 校验通过后，可在线提高已有容器额度，降低运行中容器额度需先排空。该额度不改变 2 CPU / 4 GiB owner 上限或 3 个运行中主对话限制，也不是子智能体数量限制。

引用搜索辅助进程默认空闲 60 秒退出，`GXZS_REFERENCE_IDLE_MS` 可配置正整数毫秒；查询进行中不回收，工具结果使索引失效不会延长空闲时间。下次引用沿用 DSH 原生索引重新建立，等待旧进程退出后再启动。MCP 连接在空闲 300 秒后回收，管理器最多保留 32 个缓存连接、每个 owner 最多保留 4 个；这些仅是空闲缓存目标，正在调用的连接不受该回收规则限制。MCP 和记忆调用退出尚未确认时仍计入占用，现有回收程序继续确认已结束调用的退出，外部调用的未知结果记录也继续保留。取消和清理不额外创建清理线程；Docker 客户端退出本身不能证明远端进程已退出，必须收到匹配的沙盒退出确认。

manager 的 Docker `--pids-limit` 部署目标为 1024，保留 `WORKBENCH_MANAGER_MAX_OPERATIONS=24` 和 `WORKBENCH_MANAGER_MAX_REQUESTS=32` 的有界并发；额度同时容纳 Docker 客户端线程、MCP 读取线程和控制请求。隔离测试中，10 个 owner 各保留 3 路真实 MCP 连接时 manager 占用 365 个 PID/TID，清理后回到基线 1；256 不足以容纳该场景。该测试验证辅助连接的容量和回收，不代表 30 个模型任务或浏览器任务的完整负载验收。不能用增大额度替代回收。给 manager 增加只读 `/sys/fs/cgroup:/host-cgroup:ro` 挂载，并设置 `WORKBENCH_HOST_CGROUP_ROOT=/host-cgroup`；维护程序从当前 `pids.current/pids.max` 判断压力，在压力解除前暂停新调度并保留运行中的 Host。没有该挂载时无法确认这一压力原因，仍按原健康维护规则处理。不能以累计 `pids.events:max` 单独判断当前故障。

计划调查、预览、环境安装和短暂初始化容器均使用所属 owner 的 `CgroupParent`，计入同一个 2 CPU / 4 GiB 上限及全局池。初始化容器另设 1 CPU / 256 MiB / 128 PID 上限。管理器返回的临时容量错误携带 `code`、`request_id` 和 `retry_after`，网关保留状态及这些字段；重试成功仅清除对应文件读取错误，不自动重发模型消息或外部 MCP 操作。

释放名额发生网络错误时保留投递记录并重试释放，不把已经空闲的对话转入取消流程。已经卡死的执行仍须先确认宿主和工具停止，再回收名额；不能按运行时间长短盲目过期。

## 工作区网络地址池

生产 manager 显式设置 `WORKBENCH_SANDBOX_ADDRESS_POOL` 为经过宿主机路由、DNS/VPN 和现有 Docker 网络核对的专用私有 IPv4 CIDR，例如 `10.249.0.0/16`，并设置 `WORKBENCH_SANDBOX_SUBNET_PREFIX=27`。该配置只影响新建工作区网络；现有工作区继续复用原桥接网络、IP 和卷，空闲或停止不会删除其网络。每个工作区仍使用独立 bridge，Host 与沙盒共用该工作区的网络；主对话和子智能体不会各自创建网络。

一个 `/16` 池可分配 2048 个 `/27` 网络，每张网络有 32 个地址，为 Host、沙盒和有界的临时工具容器留出容量。manager 使用线程锁与持久状态目录中的进程锁保护分配，Docker 中实际存在的子网是唯一占用依据；同时创建时检查所有 Docker 网络的重叠，对外部创建竞争重新核对，不覆盖或删除其他网络。配置必须为 RFC1918 私有 IPv4 `/16` 或更小的池，子网不小于 `/28`。不设置专用池时保留 Docker 默认分配的兼容路径，其耗尽返回 `NETWORK_POOL_EXHAUSTED` 和可关联的请求标识。

新网络采用确定性起点并选择未占用子网；成功响应丢失或重复提交时重新确认同名网络的 driver、scope 和 owner 标签。现有网络被保留，因此无需重启 Docker daemon 或迁移运行中的用户网络。池耗尽和分配繁忙分别返回 `NETWORK_POOL_EXHAUSTED`、`NETWORK_BUSY`，不启动沙盒或模型任务。

历史故障测试网络可使用 `scripts/retire-test-networks.py --network <明确名称>` 预览；执行还必须指定 `--apply --backup-dir <新备份目录>`。脚本仅接收明确的旧故障测试名称，保护所有注册工作区，核对全部容器（包括停止的容器）的网络引用，保存网络配置后按原网络 ID 删除，并在执行前重新核对身份和引用。不能以“没有运行容器”判断网络可删除。当前用户工作区的网络保留到明确退役，不能按空闲时间回收。

镜像验收的临时 manager 默认使用 `GXZS_SMOKE_ADDRESS_POOL=10.249.253.0/24` 对应的专用小子网，既有 `GXZS_SMOKE_SUBNETS` 参数仍可用于预先指定测试网段。部署前需核对这些测试网段与现场路由及其他网络的关系；临时资源按随机测试前缀精确清理。
