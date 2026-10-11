# 个人宿主与全局任务调度

## 请求链路

首次访问 `/ai/workbench/**` 时，Java 从已验证登录态生成 owner，优先复用仍有有效心跳的宿主，否则调用 manager 的 `ensure-host`。新用户的工作区 UUID 由 owner 稳定派生；已有用户必须保留索引内的原工作区。manager 串行创建个人沙盒、SSH 身份、宿主数据卷，检查健康后 Java 才登记为 ready。

宿主默认工作目录仍按对话隔离在 `/workspace/conversations/<chat-id>`。模型配置来自管理员提供的模板，模板不得从任何用户的完整 DSH_HOME 复制。用户数据不会进入镜像。

任务先保存在用户宿主 SQLite 的 `run_submissions` 中，然后经 owner/generation 身份验证向 manager 申请全局名额。拿到名额才发送到 DSH；同一对话共用一个执行名额，后续消息由 DSH inbox 排队，插队消息与原生子智能体继承该对话的名额，不按消息数或子智能体数计数。

固定限制：每个 owner 最多 3 个运行中的对话，全局最多 10 个运行中的 owner、30 个对话。等待提问回答、计划反馈或批准时释放名额，反馈后先重新申请名额再恢复；完成、失败、已暂停、已停止均不占名额。队列按首次申请顺序选择符合限制的任务，某个用户达到上限不会挡住其他符合条件的用户。停止但尚未确认结束的任务保留名额。manager 的队列持久化在 `/state/admission.sqlite3`，不能部署多个互不共享队列的 manager。

宿主心跳由 manager 检查健康后发送，不能再依赖迁移用户的静态清单。无运行任务且 30 分钟没有沙盒/调度活动的宿主停止，数据卷保留，下次访问唤醒。宿主连续健康失败超过 60 秒时先停止宿主和沙盒，再回收名额。不能单凭心跳过期直接释放运行名额。

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

先备份 manager 状态、宿主索引和个人数据卷，停止接收新任务并排空已有任务；随后部署 manager、Java 网关，再部署全部用户宿主。旧宿主没有全局调度上报，不能与新调度宿主并行提供不限额执行。

现有迁移宿主的数据目录和名称不会自动接管或重命名。上线时需要将既有工作区、宿主卷及 owner/generation 标签明确迁入受管部署，保留原索引的 workspace；停止旧的固定用户心跳脚本。owner、工作区或镜像标签不一致时拒绝自动覆盖。

上线验收应覆盖：全新账户冷启动、两个旧账户的原文件与历史、同用户第四个对话、全局第 11 位用户／第 31 个对话、队列取消、直接发送、宿主重启与数据卷恢复、manager 重启、等待用户输入期间的名额、跨用户拒绝。

## 共享资源池

在 Docker 宿主机使用 systemd cgroup v2，把 `services/sandbox-manager/systemd/gxzs-workbench.slice` 和 `gxzs-workbench-.slice.d/limits.conf` 安装到 `/etc/systemd/system/`，执行 `systemctl daemon-reload`。全局池限制 15 CPU / 30 GiB，每个工作区 slice 限制 2 CPU / 4 GiB，Host 和 sandbox 的 `CgroupParent` 必须相同。前缀 drop-in 使后续新用户自动继承配额。

manager 配置 `GXZS_OWNER_CGROUP_PREFIX=gxzs-workbench`，并将 `GXZS_HOST_CPUS=2`、`GXZS_HOST_MEMORY=4g`、`WORKBENCH_SANDBOX_CPUS=2`、`WORKBENCH_SANDBOX_MEMORY=4g` 设置为单容器上限；两容器合计仍受 owner slice 限制。MemoryHigh 在 owner 3 GiB / 全局 28 GiB 提前施加回收压力，禁用该池 swap。10 人同时运行时共享全局容量，每人 4 GiB 是弹性上限，不能视为每人保留 4 GiB。变更现有容器的 cgroup parent 需要排空后重建，个人数据卷继续复用。

沙盒的 `WORKBENCH_SANDBOX_PIDS_LIMIT` 默认 1024，可配置为正整数；Linux 的该额度同时计算进程和线程。Chromium 与 Node/SSH 工具共用额度，原来的 256 可导致 `pthread_create` / 辅助进程启动失败。manager 在容器镜像、归属网络、附件卷和 cgroup 校验通过后，可在线提高已有容器额度，降低运行中容器额度需先排空。该额度不改变 2 CPU / 4 GiB owner 上限或 3 个运行中主对话限制，也不是子智能体数量限制。

释放名额发生网络错误时保留投递记录并重试释放，不把已经空闲的对话转入取消流程。已经卡死的执行仍须先确认宿主和工具停止，再回收名额；不能按运行时间长短盲目过期。
