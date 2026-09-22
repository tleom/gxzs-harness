# Agent 技能、MCP、文件与分支的 DSH 对齐记录

本记录对应 2026-09-22 的本地代码修改，DSH 锁定版本为 `0.1.6-alpha.2`。frontend、harness 均在 `fix/workbench-dsh-fork` 当前分支继续，保留已有修改；本任务未修改 Java 后端。另一个对话负责发送、停止、队列、问题和计划，本任务负责技能、MCP 命名、文件兼容边界及分支工作目录。

## 已收敛的实现

| 项目 | 当前实现与唯一职责位置 | 结果 |
| --- | --- | --- |
| 技能 frontmatter 解析 | `packages/workbench-sandbox-skills/src/definition.js` 调用 DSH `FileSystemSkillProvider.get`，输入为 sandbox-manager 已校验的内容快照 | 删除 SandboxSkillProvider 和 WorkbenchService 自写 YAML 解析；`resource_ops.py` 只负责包、文件、安全校验，不解析 YAML |
| 技能名称、说明、metadata、invocation、source、provider | DSH 原生 definition | 不用展示名称替换 `name`；保留原生加载和排名语义，个人 provider 使用与 DSH `user-dsh` 一致的 rank 400 |
| 技能展示名称 | `metadata.displayName`；前端共用 `lib/resource-display.ts` | 列表、详情、导入确认、资源标签、技能工具记录显示展示名称，缺失或空白时用 `name` |
| 用户明确选择技能 | `resource-mentions.js` 生成原生 `/name` 手势 | DSH 自己加载技能并注入原生 skill-invocation context；不再要求模型重复调用 skill。遵循 userInvocable；允许用户调用 modelInvocable=false 的技能 |
| 模型调用技能 | DSH 原生 `skill` 工具 | 原始参数 name 不变；工具记录用目录中的 displayName 显示。历史记录在技能已删除/目录不可用时回退原始 name |
| MCP 工具定义与结果 | DSH `createMcpToolDefinition` | 工具说明来自 catalog 中服务器提供的 description；输入/输出和结果语义仍由 DSH 接管 |
| MCP 公共名称 | `packages/workbench-mcp-tools/src/names.js` | 注册、模型目录和新工具调用记录统一 `mcp__<server>__<tool>`；namespace 使用 scope + 稳定 server_id，避免个人/全局同名冲突；平台 opaque runtime_name 只作为内部注册索引 |
| MCP 能力提示词 | 移除 `gxzs:mcp-guidance` 的 Tavily/具体插件名称 | 当前工具能力以工具 description 为准；显式用户标签只表达用户选择的资源，不定义另一份工具能力 |
| memory.md 功能 | 删除 personal-resources 的 memory 返回值、memory_update 操作及前端类型 | 不再读取/保存该记忆文件；保留另一个任务实现的全局记忆 MCP。没有批量删除运行中沙盒已有文件 |
| 图片附件 | `attachments.js` 使用原生 image prompt part | 图片不再同时追加 sandbox 文件路径文本；保留原有类型、大小、版本与用户路径校验 |
| 交付与活动事件 | `projection.js` | workbench_presented/activity 继续作为 DSH 原生事件的兼容投影，并携带 native 原始事件；分支复制兼容记录时不修改 native 事件内容 |
| 分支对话 | `fork-chat.js` 始终调用 `sessionController.fork({sessionId, atSeq})` | 不再用 agents.create 手工 seed 实现生产 fork；边界裁切、新 session ID、preset 及模型历史由 DSH 生成 |
| 分支工作目录 | DSH 原生继承源 cwd，Workbench 保存目录投影 | 文件面板使用 file_directory；ensureChatSession 不把新分支重新复制到 conversations/<新ID>；共享目录仍被其他会话引用时，删除会话不会删除该目录 |

### 展示名称写法

在个人技能的 SKILL.md 中配置：

```yaml
---
name: report-check
description: 核验报告中的证据与结论
metadata:
  displayName: 报告核验
---
按实际技能说明执行。
```

展示名称是本产品使用 DSH metadata 扩展的呈现字段，并非声称 DSH 自带顶层 displayName。启用、删除、置顶和调用继续使用 `report-check`。管理页面展示名称随技能导入/文件更新生效，没有另建数据库名称副本。

## 按用户决定保留的必要适配及缺口

用户已明确选择“保留必要适配，明确集中边界和缺口”，本次没有把非图片用户附件迁往 Host 来换取原生 receipt。既有图片仍沿用 DSH image admission 和 attachment-local，远程附件存储及路径映射还未全面接入。

| 边界 | DSH 当前缺口 / 不等价点 | 保留的位置和限制 |
| --- | --- | --- |
| 外部 MCP JSON Schema | 原生 tools 校验是子集，不接受 minimum、maximum、minItems、maxItems、format 等服务器字段 | 唯一兼容模块 `workbench-mcp-tools/src/schema.js`。原生接受的 schema 原样传入；需要兼容时仅投影当前支持的额外约束为说明，原始 schema 用标准 Ajv 校验。删除自写的不完整参数验证器。未支持的其他结构仍报错，不静默放宽 |
| MCP publicToolName | 此版本 root export 只有 createMcpToolDefinition，没有导出原生 publicToolName；发布包也不包含 src | `names.js` 集中保持与 DSH 同一命名算法（字符规则、64 字符上限和哈希后缀）。上游公开该函数后应直接替换这一处；没有在 Java/前端另写算法 |
| 普通文件附件 receipt | 原生 fileUploads 依赖 attachment-local；LLM 文件路径经 fileHostPath → fs.processPathFromHostPath。当前 SSH filesystem 不提供远程附件映射 | 非图片附件的远程路径说明仍集中在 `attachments.js`，没有假装已经原生化。暂不把文件存入 Host 来换取原生 receipt。图片已消除重复路径说明 |
| workspace-files 与产品文件 API | 原生 workspace-files 按 session cwd 读取，read/stat 的范围与产品工作区边界不同；版本 token、目录 stat、CAS、批量下载接口也不等价 | 产品文件 API 继续集中走 workbench-file-manager → sandbox-manager/file_ops.py。模型常规 fs/read/write/edit/glob/grep/bash 保持 DSH SSH/runtime。没有先检查一次路径、再用不受相同 fd 约束的 Host 读取方式替换 |
| 分支标题与 Workbench 展示历史 | DSH 的标题递增规则在 client 端私有函数；Workbench 还有 runs、用户反馈、标签、问题历史和自身 SSE 投影 | 标题规则保留在 fork-chat.js；Workbench 展示记录复制用于当前 UI 兼容，DSH 模型历史由原生 fork 负责。未宣称 Workbench Session/cache/SSE 已全面变为单一原生事实源 |
| 旧 opaque MCP 历史记录 | 历史持久记录保留当时的名字 | 新目录、新调用改用公共名称；没有批量改写旧日志或已结束会话历史 |

## 保留的产品能力

- 技能导入 ZIP/MD、启停、置顶、卸载、冲突版本检查、备份和用户 `/workspace/skills` 路径管理。
- tenant/global/personal MCP catalog、owner 隔离、凭据、OAuth、grant nonce、active-run 授权、沙盒 worker、网络约束、MCP journal 和调用请求键。
- 用户沙盒路径边界、openat/nofollow/目录 fd、CAS、ZIP/批量下载、远程 spill。
- 用户级 Office preview、文件分享的签名/过期/撤销、录音/ASR、Sheet/Word/Slides 编辑与 XML 解析。
- 另一个对话负责的会话交互改动，以及独立全局记忆任务的修改。

## 数据与发布边界

- harness SQLite chats 增加可空 `directory` 列，旧会话为空时沿用 `conversations/<chatId>`；分支存储从 DSH 观察到的目录投影。初始化按列存在性补齐，原数据不重写。
- 原生 fork 继承并共享源 cwd，这是 DSH 本身的行为；分支隔离模型历史，不自动隔离文件副本。
- `copySessionDirectory` 仍服务已有旧会话目录迁移；本轮已将它移出 fork 路径。
- 本轮没有运行生产部署、数据库生产写入、提交、推送、PR 或远程 CI；已有沙盒 memory.md 不再由功能读取，但未远程批量删文件。
- 依赖更新包括原生 skill-filesystem 和 MCP 兼容校验用 Ajv，pnpm 与 Workbench npm 锁文件已同步。

## 验证记录

- harness 全量 23 个文件、200 项测试通过，语法检查通过：日志位于根工作区 `temp/dsh-resource-align-20260922/`，以最终日志中的计数为准；包含真实 DSH SkillRegistry/FilesystemSkillProvider、fork 调用、目录保护、授权与事件投影测试。
- 前端：在该目录的独立源码副本运行 5 个测试文件、87 项相关组件/活动记录测试，全部通过；完整应用 vue-tsc 退出码 0。未在原仓库执行构建。
- Linux：使用 SSH skill，在 237 的 `/tmp/gxzs-dsh-resource-align-20260922` 建立专用 venv，安装 pytest；30 项 personal resource POSIX 测试通过，未操作服务中的用户文件。
- Edge + Playwright：使用真实 Vue 组件的独立夹具验证列表中“报告核验”和 name 回退，工具记录显示“报告核验”；点击对应开关实际提交 `{operation: skill_toggle, name: report, enabled: false}`。截图在 `temp/dsh-resource-align-20260922/frontend/output/playwright/skill-display-name.png`。夹具 favicon 404，不涉及业务请求。
- 未运行生产浏览器端到端、真实付费 MCP 调用或真实沙盒模型任务，不把组件夹具验证等同部署验收。

- Workbench npm ci --dry-run --ignore-scripts 通过，仅验证安装计划；check-config、check-plugin 通过，不等同镜像构建。frontend/harness git diff --check 通过。

## 计划标签与调用手势补充（2026-09-22）

- 按最新 UI 要求新增 `WorkbenchPlanBar.vue`，放在输入框上方、与目标同一 dock。原生 `plan.pending ? !plan.active : plan.active` 决定显隐，退出调用 `/plan off`；不建立本地计划业务状态。
- 草稿 `/goal`、`/plan`、`/compact` 标签可移除并保留任务正文。发送计划后使用上方横条，当前代码不再有下方计划小显示。计划审核继续使用原生问题和现有 PlanReview。
- 技能仍是 DSH `/name` 原生调用手势，展示名称不改变内部 name。
- 当前 DSH 没有发现 MCP 插件的同等 slash 调用手势。插件标签只在 `resource-mentions.js` 中生成选中公共工具名的用户引用；已移除附加的强制调用及行为指令。能力说明来自原生 tool description，不能将这一小段引用适配称为 DSH 原生插件手势。
- 验证：输入组件与计划横条 25 项测试、harness service 67 项测试通过；前端类型检查通过。Edge 组件夹具验证发送后上方横条及退出，真实服务链路未在本轮重新运行。
