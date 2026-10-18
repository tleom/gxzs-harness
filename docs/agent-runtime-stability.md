# Agent 长期运行修复与验收

本次以 Harness `18f89dc`、DSH `0.2.1-rc.2` 为基线。源码修改和本地测试不等于已部署；生产数据库、运行镜像、真实模型及持续运行应分别验收。

## 生命周期与请求契约

- 停止 Host/Sandbox 前后均检查实际容器及归属，只有两侧停止或确认不存在才释放 admission 和 MCP fence。Docker 通信失败不是容器已消失的证明。
- 后端先支持 `degraded`，再发布新 Manager。只有当前实例存活才续期 degraded；`ensure` 必须重新确认容器归属、镜像和存活，并在回锁后确认记录未变化。降级允许读取、停止与清理，禁止新执行。旧后端无法识别 degraded，不能先发布 Manager。
- 浏览器单操作预算 30 秒，取消后 1 秒仍未结束则终止 worker；Host 等旧子进程退出后才能创建替代浏览器。重新打开由明确的客户端操作触发。
- 人工回答的持久化状态与状态事件原子提交后才释放内存等待。持久化失败可重答；强制取消仍结束本地 waiter，未能写入的记录交给恢复流程。
- 语音采用前端 120 秒、Java 110 秒、Host 100 秒、speech/provider 至多 90 秒。Java 签名的 `request_deadline_ms` 经 Host 转为内部 `X-GXZS-Deadline-Ms`，各层仅缩短剩余期限。旧字段缺失使用本层上限。同步 Servlet 不保证浏览器断开时立即取消 provider。
- Manager 错误保留有界 `code`、`request_id`、`retry_after`。文件版本冲突为 `FILE_VERSION_CONFLICT`；无 code 的旧客户端兼容路径仍保留。未知操作结果不自动重放。

## 历史与文件

冷恢复为每个 chat 构建一次 message/run 索引，不再按每条消息解码完整 run 列表。状态查询的四个 SQLite 部分索引只索引结束、开始、context 和 steering 事件；计时查询明确选择专项索引，避免 SQLite 在缺少统计信息时退回完整 JSON 扫描。

旧库首次打开时需要一次线性建索引，可能增加启动时间和临时磁盘占用。升级前按现有备份流程备份 SQLite 文件及 WAL 状态，预留空间，在排空的 owner 上确认首次打开与再次打开耗时。索引是兼容旧读取程序的附加结构，回滚代码无需删除索引或事件。

大于 20 MiB 的文件通过 metadata version 执行删除，不为删除读取整份内容；下载与在线编辑的原上限保留。删除前检查打开文件与路径身份。版本检查是乐观并发保护，POSIX 的最后一次路径检查和 unlink 不是针对任意 shell 写入者的原子 CAS；操作期间应避免其他进程持续替换同一路径。

## 存储与保留

Host health 的 `storage` 报告 home/workspace 的可用字节与 inode；Manager diagnostics 报告 STATE 所在文件系统。`GXZS_STORAGE_MIN_FREE_BYTES` 默认 268435456（256 MiB），`GXZS_STORAGE_MIN_FREE_INODES` 默认 1024，两者允许配置非负整数。已配置的路径不存在或不可读时报告 unknown 并阻断新准入；仅明确省略的可选路径（例如内存数据库没有持久 home）标为 unmounted。水位用于暂停新 acquire，已有 renew/release、查询和停止保持可用，释放空间后自动恢复准入。

这是一道写入前的保护，不替代宿主机/卷的硬配额。上线时应逐个确认 home、workspace、environment、Manager STATE 的实际 backing filesystem、剩余 inode、配额、告警接收方与增长趋势。每个 owner 的硬配额应由容器存储驱动或独立文件系统实施；本次不改变生产挂载或存储布局。

离线容量台账使用 [storage-inventory.py](../scripts/storage-inventory.py)，在 **Linux Docker daemon 宿主机** 上运行，`--state` 填 Manager STATE 的宿主机目录，`--sandbox-prefix` 填该部署的 `WORKBENCH_SANDBOX_PREFIX`。使用有权限读取卷目录的运维账号，输出放到 STATE/owner 卷以外，权限设为仅运维可读：

```bash
umask 077
python3 -B scripts/storage-inventory.py --state /srv/gxzs/manager-state \
  --sandbox-prefix dify-wb-dev --workspace 11111111-1111-4111-8111-111111111111 \
  > /srv/gxzs-audit/storage-first.json
# 在实际采样间隔之后，使用同一范围和部署配置
python3 -B scripts/storage-inventory.py --state /srv/gxzs/manager-state \
  --sandbox-prefix dify-wb-dev --workspace 11111111-1111-4111-8111-111111111111 \
  --previous /srv/gxzs-audit/storage-first.json > /srv/gxzs-audit/storage-next.json
```

路径、prefix 和 UUID 是示例，需替换为实际值。可重复 `--workspace`，或明确用 `--all` 盘点 registry；默认最多 100 个 owner、100,000 个目录项、30 秒遍历预算、64 层深度，可用 `--max-owners/--max-entries/--max-seconds/--max-depth` 调整。Docker 查询固定到本机 Unix socket，rootless daemon 可用 `--docker-socket` 指定；不继承远端 Docker context。脚本不导入 Manager 服务，不启动容器、不写数据、不清理历史，也不加入 health 热路径。时间预算在操作之间检查，不能抢占内核阻塞的文件系统调用，远程文件系统应使用其专用监控。

台账按 registry 的持久卷身份解析实际 `docker volume inspect` 挂载点，分类为 Host home（含 Session、run/events、附件）、Sandbox home（含 `.gxzs-global-memory`）、workspace（含 spill、输出、个人资源和资源备份）、environment（含各版本）、owner STATE。共享 SQLite、operation receipt 等 Manager STATE 另列 `manager_shared_state`，不猜测每个 owner 的数据库页占用。Host/Sandbox 的附件和 workspace 重复挂载只计其底层卷一次。未注册/退役遗留卷、Docker 镜像/日志/可写层及外部存储另属宿主机容量盘点，不能把本台账当作整盘 `du`。

`apparent_bytes` 为普通文件逻辑长度，`allocated_bytes` 为包含目录和链接元数据的 `st_blocks × 512`，`inodes` 为每个根内去重后的 inode 数；硬链接不重复计费，符号链接只计自身、不跟随，稀疏文件分别呈现逻辑/分配大小。普通 local volume 以外的驱动、绑定/远程卷选项、无权限、身份冲突、扫描中可检测的目录变化、跨设备子目录和预算耗尽均报告 partial。输出只含身份与汇总计数，不列文件名或内容。在线扫描不是原子快照；文件可在扫描期间增长，增长率用于趋势，应在空闲期或文件系统快照上采集需要一致性的账目。

退出码 0 表示本次指定范围遍历完整，2 表示 partial/参数错误；partial 的计数仅为已观察量。`growth.status=available` 只在两次范围、卷创建时间、根 inode、数据类别都一致且扫描完整、采样窗口不重叠时给出各类别净增长与日均变化；partial、存储替换和范围变更不会被误报为释放空间。`growth.status=unavailable` 可与本次完整扫描并存，必须同时检查。实际配额、告警阈值、采样周期与保留期仍由部署容量和业务要求确定。

保留边界：

| 数据 | 默认处置 |
| --- | --- |
| 用户文件、附件、原生 Session、run/events、memory | 保留；归档、导出、压缩或删除按明确的数据保留要求执行 |
| 成功的环境旧版本、资源备份、迁移备份 | 保留回滚依据；按实际引用、备份验证与保留期生成清理计划后处理 |
| 本次 skill import 失败产生的未提交 staging | 立即清理，只作用于该次新建 staging |
| installer installing/unknown、MCP 未确认结果 | 保留并核对，不能按 TTL 解释为成功、失败或可安全重试 |
| 已明确 ready/failed 的旧 installer receipt | 继续既有 OPERATION_RETENTION 策略 |

旧 root `environment` 管理入口仍兼容：owner 锁只保护准备和状态转换，安装在锁外运行；同 owner 的 durable gate 防止多个 installer 同时提交。超时先确认停止，再读取 current request manifest。容器不存在或处于 created 状态不能证明安装失败，Docker 启动请求可能仍在途中；只有已提交的 request manifest、明确 exited/dead 状态或实际执行并确认停止，才能收敛为完成结果。未确认时返回 unknown，禁止继续安装；旧记录缺少 workspace/request identity 时保留给维护人员核对，不声称已经回滚。维护处理需先核实原请求与容器不会再执行、核对 current manifest，再处理该记录；不能通过删除 unknown receipt 自动重试。正常 Agent 安装依赖仍使用原生 shell。

## 依赖与 MCP 支持范围

`node scripts/audit-dependencies.mjs` 对四个生产 npm 锁树生成 JSON 报告。CI 报告漏洞发现，扫描执行错误阻断；包节点数包含依赖父节点，不能当作独立漏洞数。依赖升级必须重新安装、检查真实版本并完成 Office/图像/Mermaid 冒烟；不能把锁文件升级当作镜像已更新。

sharp 升级针对 [维护者 librsvg 公告](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w)，image-size 升级针对 [图片解析循环公告](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)，fflate 升级针对 [ZIP64 解析公告](https://github.com/advisories/GHSA-px8p-9vwx-vf98)。Office 剩余两条公告的七个节点、实际调用路径和处置边界见 [依赖专项复核](dependency-advisories-20261018.md)，不承诺依赖或 OS 漏洞清零。

平台 MCP 当前契约为 `platform-tools-v1`，不是原生 MCP 全功能代理。Host health 的 `mcp_capabilities` 明确声明支持范围：

| 能力 | 平台 bridge |
| --- | --- |
| tools catalog、JSON schema、工具执行、冻结资源授权、超时/取消 | 支持 |
| 原生工具重名处理 | 仅冲突工具生成基于稳定身份的别名；调用仍绑定真实 resource/server/tool identity |
| 首次目录失败 | 准入关闭，刷新循环继续，修复目录后可恢复 |
| server instructions | 未接入 |
| resources/list、resources/templates/list、resources/read | 未接入；不能假定资源型 server 可作为工具使用 |

扩展 resources 需要单独建立 URI、owner、server、版本和内容大小的授权/读取契约。当前前后端没有该消费者，本轮明确能力边界，不另建一套未经设计的资源授权体系。

## 发布与验证

先应用后端凭据双版本的附加迁移、排空旧凭据写入实例并发布兼容后端；再发布 frontend 与 Manager/Host/Sandbox 镜像。精确顺序、凭据回滚限制见后端 `script/agent-stability-rollout.md`。运行中的 owner 不靠修改 tag 原地假定更新，按既有 drain/fence/replace 流程核对 image digest。

验收至少区分：本地故障注入、真实 Linux 文件系统/MCP transport、镜像构建/原生浏览器/Office、真实数据库与配置迁移、跨三端请求、真实模型、24/72 小时持续运行。每层记录源码指纹、镜像 digest 和结果；未运行的层级保留待验收，不能由局部测试代替。
