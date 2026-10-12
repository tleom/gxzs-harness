# DSH 0.2.1-alpha.2 适配核对

上游版本：`dsh-v0.2.1-alpha.2`，源码提交 `d743267`。Workbench profile 与所有 DSH 原生包固定为 `0.2.1-alpha.2`，Cordis 固定为 `4.0.5-alpha.1`。上游发布说明：<https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.2>。

## 能力归属及变化

| 范围 | 适配处理 | 验证入口 |
| --- | --- | --- |
| 定时任务 | 启用原生 Schedule，在 Workbench admission 与 MCP 边界注册后启动；JSON domain、计算下次时间、投递与历史均由 DSH 管理 | `native-schedule.test.js` 使用已发布包和真实 JSON 存储，验证投递、重启、更新冲突及归档停止 |
| 定时投递 | 原生消息 `source.kind=schedule` 映射为一次业务运行，保留冻结资源和原生消息身份；恢复历史不重新投递，不更改会话标题 | `schedules.test.js`、native lifecycle 测试 |
| 子智能体 | 目录与历史来自原生 SessionController，按父会话目录校验归属；外部运行子智能体不开放本地历史 | `sidebar-gateways.test.js` |
| 后台子智能体 | 运行权限依赖实时 AgentRegistry ownership；父轮完成后仅其仍在运行的子智能体继续使用该轮冻结 MCP 资源及 admission，全部退出后释放 | `mcp-runtime.test.js`、`scheduler.test.js` |
| 终端 | 复用原生 TerminalController 的 PTY、屏幕快照、写权限、resize、retain/follow 和 close；浏览器断线不创建新 Shell | `sidebar-gateways.test.js`，部署时 SSH/PTY 冒烟 |
| 删除会话 | 先原生 archive/stopActivity 提交唤醒围栏，停止定时任务、后台活动与终端，再取消运行并按目录版本删除私有任务目录 | `service.test.js`、真实 Schedule 停止测试 |
| 工作目录 | 原生 WorkingDirectory 依赖接入测试及 recorder；默认目录按上海日期分层，手选 Workspace 直接作为所有成员会话的 cwd | `service.test.js`、HTTP 集成测试 |
| 文件改动捕获 | 原生捕获入口改为 `fs/write-intent` / `fs/edit-intent`；继续使用 owner Sandbox 文件系统和 scratch provider | `native-changes.test.js`、`smoke-native-sandbox-tools.mjs` |
| 写入准备阶段 | 在工具参数增量阶段发布同 callId 的准备状态；正式调用和结果到达后原位替换，原始增量不作为业务工具调用落库 | projection/history presentation 测试 |
| 原生历史窗口 | 初始元信息不视为可见的更早内容；游标有界向前推进；子智能体刷新补齐前后窗口之间的缺口 | history-page/history presentation 测试、前端历史测试 |
| 技能目录 | 保留平台技能 displayName 补丁；对目标版本锚点与已发布代码验证，避免静默套用旧版变换 | `check-dsh-skill-catalog.mjs` |
| Goal / Plan / Resume | 继续使用原生控制与隐藏 followup，不新增替代驱动，不把 Resume 当作新的首条用户消息 | 原生 Goal、多轮、暂停恢复和冻结资源测试 |

## 前端对应行为

定时任务采用个人技能/插件相同的列表弹窗，点击进入规则或运行记录；相关工具记录和创建结果可打开右侧详情。子智能体从顶部目录打开右侧只读对话，保留主会话。

右侧默认“开始”，其中提供文件、终端、浏览器。开始存在时隐藏加号；加号打开开始。文件浏览标签及浏览器各一个，终端可多个。标签、文档及浏览器状态按账号和会话保存；终端保留原生 lifetime，失效后不自动重建。开始、终端、浏览器、时钟、状态点和换行使用 DSH 对应 SVG。

工具展开区复用上游 todo diff 与 inspection/detail model，添加原生换行和复制；文件记录显示 basename，完整路径仍用于 tooltip、读取和跳转。完成后收起工具记录。长行差异背景覆盖完整可滚动宽度，浮窗与侧边栏共享同一差异组件。深浅主题读取应用主题变量。

HTML 预览在父页面通过认证读取同目录资源，再装入没有同源权限的脚本 sandbox；支持普通脚本、模块静态/字面量动态 import、CSS 引用及图片。认证信息不进入预览页面。任意运行时计算的相对 fetch 地址不作静态重写；复杂应用可以下载后在完整服务环境打开。

## 新对话与目录规则

- 顶部新对话按原生 `UiWorkspaceService.startSession` 规则，优先当前 Workspace，否则选择最近 Workspace。分组内新建显式指定该组；未分组新建显式不选择 Workspace。
- 新对话立即显示本地“新对话”占位行。未使用时切换或再次新建会移除占位；发送后才创建后台会话并以首条消息暂命名，随后接收原生标题。
- 默认新任务目录：`/workspace/conversations/YYYY-MM-DD/<chat UUID>`；历史会话保留已有目录。
- 手选 Workspace 直接作为 cwd；所有成员会话共享该目录。文件树显示实际目录名称，不以成员会话标题替代 Workspace 文件夹。
- Codex 公开 app-server 协议的 `Thread.cwd` 是绝对路径。日期目录由本项目按用户要求实现，未将 GitHub 用户问题中的桌面示例当成公开实现源码。

## 部署与恢复

数据库无新增字段或 SQL 迁移。部署顺序为后端受控路由、237 Host/Sandbox 成对升级并更新 SSH helper hash、235 前端。保持 owner、Workspace、home volume 与目录不变，通过现有 drain/fence/replace 流程升级，不强停正在运行的任务。

上线前备份 manager 状态、原生会话、Workbench SQLite、配置及 owner 持久卷；在新镜像中对历史会话副本做读写重开验证。回滚使用此前镜像、helper hash、部署配置和备份；新建定时任务数据须随原生 JSON domain 一起保留。

本文件列出验证入口，不代替具体运行结果。每轮的实际测试数、CI、镜像 SHA、部署和持久化检查结果记录在对应 PR 与部署产物中。
