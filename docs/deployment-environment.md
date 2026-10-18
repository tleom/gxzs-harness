# 部署环境变量

所有密钥放入部署平台 Secret、Docker secret 或权限为 `0600` 的宿主机 env 文件。不要提交真实值。

## 1. `gxzs-ai` / Java 后端

```dotenv
AI_WORKBENCH_ENABLED=true

# Java签发给DSH host的请求断言。主密钥不复制到host；按owner/代次/实例派生。
DIFY_GXZS_ISSUER=gxzs
DIFY_GXZS_SIGNING_KEY=<base64，解码后至少32字节>

# Java平台代理主密钥。只留在Java；每个host使用其派生token。
GXZS_PLATFORM_INTERNAL_KEY=<base64，解码后至少32字节>

# 独立sandbox-manager
GXZS_SANDBOX_MANAGER_URL=http://gxzs-sandbox-manager:5010
GXZS_SANDBOX_MANAGER_TOKEN=<随机高熵bearer>

# 公开分享和OAuth callback的外部根地址，无路径尾斜杠也可。
GXZS_AI_PUBLIC_BASE_URL=https://ai.example.com

# OpenAI兼容的 /audio/transcriptions 接口。没有STT时留空会返回409。
GXZS_SPEECH_URL=https://speech.example.com/v1/audio/transcriptions
GXZS_SPEECH_TOKEN=<provider bearer>
GXZS_SPEECH_MODEL=sensevoice
GXZS_SPEECH_MAX_BYTES=15728640

# 32个ASCII字符，用于数据库中MCP client secret/token/header凭据的AES加密。
GXZS_MCP_CREDENTIAL_KEY=<恰好32字符>
# 逗号分隔的精确hostname；全局MCP和OAuth token endpoint均必须命中。
GXZS_MCP_ALLOWED_HOSTS=mcp.example.com,oauth.example.com

# host claim/heartbeat/session索引内部接口的独立bearer。
GXZS_ORCHESTRATOR_TOKEN=<随机高熵bearer>
```

生成建议：

```bash
openssl rand -base64 32  # DIFY_GXZS_SIGNING_KEY
openssl rand -base64 32  # GXZS_PLATFORM_INTERNAL_KEY
openssl rand -base64 48  # manager/orchestrator bearer
openssl rand -hex 16     # GXZS_MCP_CREDENTIAL_KEY，正好32字符
```

## 2. 独立 `sandbox-manager`

```dotenv
WORKBENCH_SANDBOX_MANAGER_TOKEN=<只与Java共享的管理主凭据>
WORKBENCH_SANDBOX_IMAGE=<已验证的sandbox镜像digest>
WORKBENCH_SANDBOX_NETWORK=gxzs-ai-sandboxes
# 专用池示例；部署前核对宿主机路由、DNS/VPN 和 Docker 子网，避免冲突。
WORKBENCH_SANDBOX_ADDRESS_POOL=10.249.0.0/16
WORKBENCH_SANDBOX_SUBNET_PREFIX=27
WORKBENCH_SANDBOX_PREFIX=gxzs-wb
WORKBENCH_MANAGER_STATE=/state
# Docker 宿主机上持久保存的已发布技能；Host 与 Sandbox 同路径只读挂载。
# 目录必须预先存在，发布前核对完整 SKILL.md、脚本、引用资源和 SHA-256 清单。
GXZS_GLOBAL_SKILL_HOST_DIR=/srv/gxzs/global-resources/skills
# Java根地址；manager会调用 /internal/ai/mcp/authorize。
WORKBENCH_MCP_API_URL=http://gxzs-backend:8080
```

manager需要：

- 持久卷挂载到`/state`；
- Docker socket或等价的受限容器编排接口；
- 仅内网暴露5010；
- Java和manager之间共享`GXZS_SANDBOX_MANAGER_TOKEN`；
- 与用户sandbox处于可管理的Docker网络，但不要公开5010。

设置 `GXZS_GLOBAL_SKILL_HOST_DIR` 后，原生技能根固定为 `/opt/workbench-global/skills`。
更换挂载目录须先 drain/fence，再创建新容器；禁止将技能仅复制到临时容器层。
同一路径的根目录也不能通过删除或整体重命名替换：现有 bind mount 会继续引用旧目录。
日常更新保留根目录 inode，按文件原子更新；确需整体换根时，按换代流程重新创建容器。
使用 `--mount` 校验源目录存在，避免 Docker 自动创建空目录造成静默丢失。
验收必须比较原发布清单的名称、展示名、内容摘要和全部配套文件，并检查新建、重建的
Host/Sandbox 目录与计划调查容器读取一致。个人技能仍保存在各自 workspace 卷。

生产沙盒构建须传入已核对的 `WORKBENCH_FONT_IMAGE` 私有字体资产镜像，不能使用公共 CI
的默认系统字体阶段替代。发布前后比较字体 manifest 的 generation、文件数与 SHA-256，
验证字体匹配和中文文档转换；同时验证 Git、Python/Node、Office、OCR、浏览器及个人环境卷。

生产镜像验收必须把资源根目录传给现有 smoke 入口（目录内含 `skills-manifest.json`、
`skills/` 和 `fonts/manifest.json`），在切换 Manager 或用户运行环境前执行：

```bash
GXZS_GLOBAL_RESOURCES_DIR=/srv/gxzs/global-resources \
  bash scripts/smoke-images.sh "$HOST_IMAGE" "$MANAGER_IMAGE" "$SANDBOX_IMAGE"
```

该入口对 Host/Sandbox 实际挂载的技能全量文件进行哈希核对，并运行 Sandbox 环境自检、
比对生产字体数量和 generation；漏文件、内容变化或误用 `system-fonts` 均失败退出。
发布技能或字体时先明确更新资源及对应清单，不能只修改清单来绕过核验。
个人环境使用独立持久卷，重建容器时保留原有 home、workspace 和 environment 卷。

## 3. 每个owner一个DSH host

```dotenv
DSH_HOME=/srv/dsh
DSH_TELEMETRY_DISABLED=1
DSH_PERMISSION_MODE=danger-full-access

GXZS_HOST_OWNER_ID=<tenantId:userId>
GXZS_HOST_GENERATION=<正整数，从1递增>
GXZS_HOST_INSTANCE_ID=<该代次唯一实例ID>

GXZS_ASSERTION_ISSUER=gxzs
GXZS_ASSERTION_SIGNING_KEY=<manager按owner/generation/instance派生的base64 key>
GXZS_ASSERTION_AUDIENCE_PATH=/ai/workbench

GXZS_SANDBOX_MANAGER_URL=http://gxzs-sandbox-manager:5010
GXZS_SANDBOX_MANAGER_TOKEN=<manager按owner/workspace/generation/instance派生的base64url token>
GXZS_SANDBOX_WORKSPACE_ID=<平台分配的固定UUID>
GXZS_SANDBOX_WORKSPACE=/workspace
GXZS_SANDBOX_SSH_HOST=<OpenSSH config中的sandbox别名>
GXZS_SANDBOX_NODE=/usr/local/bin/node
GXZS_SANDBOX_RG=/usr/bin/rg
GXZS_SANDBOX_PTC_BOOTSTRAP=/opt/dsh/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js
GXZS_SANDBOX_HELPER=/opt/dsh/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js
GXZS_SANDBOX_HELPER_HASH=<部署镜像中helper.js的64位小写SHA-256>

GXZS_PLATFORM_INTERNAL_URL=http://gxzs-backend:8080/internal/workbench
GXZS_PLATFORM_INTERNAL_TOKEN=<由Java平台主密钥按owner/generation/instance派生>
```

派生每个host的token：

```bash
GXZS_PLATFORM_INTERNAL_KEY='<Java主密钥>' \
node scripts/derive-host-token.mjs '<tenantId:userId>' '<generation>' '<instance-id>'
```

把输出写入该host的`GXZS_PLATFORM_INTERNAL_TOKEN`。不要把`GXZS_PLATFORM_INTERNAL_KEY`放进host。

模型provider所需API key继续按DSH对应provider的环境变量注入，不放进`settings.yaml`、workspace或sandbox。

`GXZS_SANDBOX_RG`、`GXZS_SANDBOX_NODE` 和 `GXZS_SANDBOX_PTC_BOOTSTRAP` 必须是用户沙盒内的路径。搜索适配器只将上游搜索工具解析出的宿主 rg 路径映射到沙盒 rg，其他命令保持原样并继续经 SSH 执行。沙盒镜像须包含可执行的 rg、Node 和对应版本的 PTC `process.js`；不能仅在 DSH host 内安装依赖。

可供模型再次读取的大输出保存到用户沙盒 `/workspace/.agent-output/<session-hash>/<random-id>.txt`，使用远端文件系统原子创建和 0600 文件权限；读取和搜索复用同一个 SSH 文件系统。此目录随用户 workspace 卷保留。当前不自动清理历史输出，清理由 workspace 生命周期策略管理。DSH host 的会话数据库、模型凭据和附件缓存属于控制服务内部数据，不作为模型文件操作的工作目录。

## 4. 必须保持一致的值

| Java | DSH host / manager |
| --- | --- |
| `DIFY_GXZS_ISSUER` | `GXZS_ASSERTION_ISSUER` |
| `DIFY_GXZS_SIGNING_KEY` | manager据此派生`GXZS_ASSERTION_SIGNING_KEY`，host不持有主密钥 |
| `GXZS_SANDBOX_MANAGER_TOKEN` | manager主凭据；host仅持有绑定owner和代次的派生token |
| `GXZS_PLATFORM_INTERNAL_KEY` | 仅用于派生host token，不复制主密钥 |
| `GXZS_ORCHESTRATOR_TOKEN` | host编排器调用Java内部索引接口时使用 |

## 5. 启用顺序

1. 在批准的维护窗口内备份业务数据库、manager `/state`、owner DSH home 和 workspace/env 卷；准备已验证的三类镜像和可回滚源码版本。
2. 按后端 migration 清单预览与执行数据库升级。根工作区 `sql/migrations/20260922_global_memory.sql` 不属于任何仓库提交；须单独交付。资源初始 disabled，验收后再启用。
3. 升级 Java 和 manager，保留功能开关关闭。旧 host 持有共享主凭据，与新派生凭据协议存在兼容边界，必须完成 drain、fence 和受控换代，不能宣称普通滚动升级即可兼容。
4. Java 先登记 owner 的 `provisioning` 代次；manager 创建沙箱、SSH、稳定 home 和 host，立即回报 endpoint。host 的 config/catalog 在此阶段允许受限 bootstrap。
5. 原生会话恢复和完整 MCP catalog 均成功后，host `/health` 才报告 `ready:true`。manager 在锁外探活并回报 ready，Java 再放行任务。`live:true` 仅证明 HTTP 服务已启动。
6. 先灰度一个 owner，核对旧 chat、文件、SSE、Goal、重试、停止、MCP、Office 预览及换代恢复。镜像中的 helper SHA-256 必须与 host 配置一致。
7. 每个 owner 通过 `replace-host` 协议升级：活跃任务先 drain，确认 host/sandbox 都停止后 fence，再复用原 home/workspace/env。保留旧容器和卷作为回滚证据。

本文件是部署契约，不是部署记录。参见 `repair-contract-20260922.md` 的精确签名和 MCP 协议；构建及验证入口见 `services/sandbox/README.md`。
