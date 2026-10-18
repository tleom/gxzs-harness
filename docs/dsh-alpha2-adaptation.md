# DSH 0.2.1-alpha.2 适配核对

本文保留 alpha.2 阶段的历史核对记录。当前运行基线已升级为 `0.2.1-rc.2`，以 `profiles/workbench/package.json`、`package-lock.json`、构建补丁检查及镜像实际安装结果为准。下述版本和阶段测试数字不代表当前发布状态。

上游版本：`dsh-v0.2.1-alpha.2`，源码提交 `d743267`。Workbench profile 与所有 DSH 原生包固定为 `0.2.1-alpha.2`，Cordis 固定为 `4.0.5-alpha.1`。上游发布说明：<https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.2>。

## 能力归属及变化

| 范围 | 适配处理 | 验证入口 |
| --- | --- | --- |
| 定时任务 | 启用原生 Schedule，在 Workbench admission 与 MCP 边界注册后启动；JSON domain、计算下次时间、投递与历史均由 DSH 管理 | `native-schedule.test.js` 使用已发布包和真实 JSON 存储，验证投递、重启、更新冲突及归档停止 |
| 定时投递 | 原生消息 `source.kind=schedule` 映射为一次业务运行，保留冻结资源和原生消息身份；恢复历史不重新投递，不更改会话标题 | `schedules.test.js`、native lifecycle 测试 |
| 子智能体 | 目录与历史来自原生 SessionController，按父会话目录校验归属；外部运行子智能体不开放本地历史 | `sidebar-gateways.test.js` |
| 后台子智能体 | 运行权限依赖实时 AgentRegistry ownership；父轮完成后仅其仍在运行的子智能体继续使用该轮冻结 MCP 资源及 admission，全部退出后释放 | `mcp-runtime.test.js`、`scheduler.test.js` |
| 后台任务列表 | 原生 JobController 的列表、非消费式输出与停止接口经 owner、Session 和 job ownership 校验；前端入口紧随子智能体，有记录时显示，清空仅隐藏已结束记录 | `jobs.test.js`、前端 Job 菜单及流生命周期测试 |
| 终端 | 复用原生 TerminalController 的 PTY、屏幕快照、写权限、resize、retain/follow 和 close；浏览器断线不创建新 Shell | `sidebar-gateways.test.js`，部署时 SSH/PTY 冒烟 |
| 删除会话 | 先原生 archive/stopActivity 提交唤醒围栏，停止定时任务、后台活动与终端，再取消运行并按目录版本删除私有任务目录 | `service.test.js`、真实 Schedule 停止测试 |
| 工作目录 | 原生 WorkingDirectory 依赖接入测试及 recorder；默认目录按上海日期分层，手选 Workspace 直接作为所有成员会话的 cwd | `service.test.js`、HTTP 集成测试 |
| 文件改动捕获 | 原生捕获入口改为 `fs/write-intent` / `fs/edit-intent`；继续使用 owner Sandbox 文件系统和 scratch provider | `native-changes.test.js`、`smoke-native-sandbox-tools.mjs` |
| 写入准备阶段 | 在工具参数增量阶段发布同 callId 的准备状态；正式调用和结果到达后原位替换，原始增量不作为业务工具调用落库 | projection/history presentation 测试 |
| 原生历史窗口 | 初始元信息不视为可见的更早内容；游标有界向前推进；子智能体刷新补齐前后窗口之间的缺口 | history-page/history presentation 测试、前端历史测试 |
| 技能目录 | 保留平台技能 displayName 补丁；对目标版本锚点与已发布代码验证，避免静默套用旧版变换 | `check-dsh-skill-catalog.mjs` |
| Goal / Plan / Resume | 继续使用原生控制与隐藏 followup，不新增替代驱动，不把 Resume 当作新的首条用户消息 | 原生 Goal、多轮、暂停恢复和冻结资源测试 |

## 前端对应行为

定时任务采用个人技能/插件相同的列表弹窗，点击进入规则或运行记录；运行时间使用原生重复选项、时间选择和时区搜索，相关工具记录和创建结果可打开右侧详情。子智能体入口紧随标题，有子任务时显示；右侧复用聊天记录，一次性任务只读，可继续任务通过原生 SubagentRuntime.prompt 收取消息，保留主会话。

右侧默认“开始”，其中提供文件、终端、浏览器。开始存在时隐藏加号；加号打开开始。文件浏览标签及浏览器各一个，终端可多个。标签、文档及浏览器状态按账号和会话保存；终端保留原生 lifetime，失效后不自动重建。开始、终端、浏览器、时钟、状态点和换行使用 DSH 对应 SVG。标签条、关闭、加号、全屏和侧栏展开收起保留本系统原有尺寸与 hover；当前标签关闭按钮常驻，其他标签仅悬浮或键盘聚焦时显示。

标签页数量不设额外前端上限；后台使用原生 TerminalController 默认的 8 个保留终端及待分配进程保护。SSH 和 PTC 启动使用新版 `launch` 结构。删除私有目录等待原生 workspace/session-activity 全部结束；取消子任务按原运行绑定，延迟的旧停止请求不能取消后续运行的子任务。新表面的圆角、hover、浮层和截断提示统一使用本系统主题。

工具展开区复用上游 todo diff 与 inspection/detail model，添加原生换行和复制；文件记录显示 basename，完整路径仍用于 tooltip、读取和跳转。完成后收起工具记录。长行差异背景覆盖完整可滚动宽度，浮窗与侧边栏共享同一差异组件。深浅主题读取应用主题变量。

任务执行中与等待补充信息共享末尾三个点及渐变动画，每轮扫光 2.5 秒、停顿 1.5 秒；减少动态效果设置关闭动画。主题识别使用 Ant 派生背景，深色滚动条不再读取固定为白色的种子背景。文件及目录下载使用认证文件接口，目录由 manager 生成 ZIP。开始、文件和预览标签按打开顺序排列并支持拖动，顺序按对话保存；关闭最后一个标签收起侧边栏。定时任务新建入口调用新聊天，规则和运行记录在详情页显示，返回列表位于标签行右侧。

`mcp` 与 `skills` 根目录保留查看和 ZIP 下载，文件管理不允许删除根目录；资源管理的专用卸载流程继续处理单个资源。草稿语音使用 `chats/draft/audio`，不将本地 `draft:` ID 发送到 UUID 路由，也不为听写创建空后台会话。终端首行上方留白缩小，真实 TerminalController 冒烟校验当前会话目录和 owner Sandbox UID。

## 审核及连接修复

恢复尚未建立 Workbench receipt 的原生定时投递时，等待 MCP 目录首次确认后冻结资源；已有 receipt 保持原授权不覆盖。任务名称补充是可重试的展示信息，读取失败不能阻断 admission。HTTP 定时任务创建在响应断开时取消；停止原生子任务通知同时围栏其绑定的父运行，覆盖子任务沿用的 MCP 权限。

删除私有目录先等待 `agent.whenIdle()`，再通过原生 `workspace/session-activity` waterfall 等待后台活动结束；回归覆盖活动未结束时不读取或删除目录。manager 拒绝截断或 chunked 请求以及缺少调度身份的请求，最终 socket 响应断开单独处理。

Java manager 客户端固定 HTTP/1.1，完整 MCP 同步读取失败返回 503，保持健康来源隔离与原生 transient 处理。235 manager 调用和 237 平台回调采用已核对 owner 身份及内容摘要的内网入口，配置按实际 Compose/容器环境更新，不以重启代替重建。

可继续子智能体输入支持图片粘贴、拖放及选择，通过原生 Attachment Store 和 SubagentRuntime.prompt 处理。历史图片按父会话归属校验后认证读取。原生子任务完成及 Agent Team Inbox 通知可以唤醒父 Agent，投影成关联的自动续轮；停止围栏、历史恢复和请求幂等仍由已有运行及原生 Inbox 协作。

## 升级记录逐项适配边界

正常完成仅结束当前父轮，不触发 MCP 取消围栏；用户停止、执行失败及中断仍保留围栏。侧栏向历史子智能体发送新消息时，新执行凭据沿用已授权的冻结插件范围，不解除旧运行的停止保护；该凭据不作为父聊天的用户消息展示。原生首条消息通过 message ID 识别，追加消息不会重复显示为首条。子智能体回复在父会话中显示为带名称的用户消息气泡。

终端沿用原生 OSC 主题与按单元格计算对比度的光标实现，明暗切换不覆盖程序调色板；xterm 6 自有滚动条复用系统颜色、宽度和圆角。内边距放到实际终端元素，确保 FitAddon 在计算可见行列时扣除边距；获取写权限后重新适配并聚焦，终端控制键不触发工作台快捷键。

| 上游变更 | 本项目处理 |
| --- | --- |
| `working_directory` 与 SDK cwd | 启用原生服务与工具；实际 profile 冒烟检查模型工具可见性、owner Sandbox cwd 和冷恢复 |
| SSH 独立 helper、Node PTC | 使用新版 `launch`，成对部署 Host/Sandbox 和 helper hash；真实 SSH 文件、PTY、Node PTC 冒烟 |
| Python PTC sandbox policy | 继续提供原生 sandbox/sandboxPolicy；不使用 Host 文件系统替代 owner Sandbox |
| 删除 `both` 与行级 `dshHome` | profile 与生成配置检查只使用原生支持字段；指令目录按 `DSH_HOME` / `DSH_AGENTS_HOME` 解析 |
| 子智能体 ID、`session/wait`、完成通知、Agent Team Inbox | 使用发布包的 SubagentRuntime、SessionController 和直接 Inbox；真实生命周期验证完成通知续轮及恢复幂等 |
| 工作步骤收起时机 | Workbench 按用户指定的回答完成后自动收起；共享主聊天及子任务展示 |
| 子代理图片续发、后台工作流状态 | 原生图片协议与实时 ownership 贯穿 API、历史、输入栏；不以父轮结束推断子任务中断 |
| 流超时、动态系统提示词/工具、pi-ai、插件准备与监听关闭 | 更新发布包并保留原生实现，运行原生生命周期、取消、插件配置和模型目录检查 |
| 长行、Shell 详情、自动标题 | UI 使用原生详情模型及长行降级策略，标题由原生生成并保持会话权威 |
| 远程目录选择、侧栏目录迁移提示 | 使用 Workbench 已有远程目录选择器及父会话归属约束；外部子任务仅显示可用性说明 |
| 字体设置、麦克风/VAD、Web TLS、Windows/macOS 安装器/PTY | Workbench 继续使用本系统主题、语音和网关；原生桌面/Web 设置及安装器不作为 Workbench 入口，不覆盖系统配置 |
| 实验性翻译、Git Worktrees、插件 Session 状态、Claude Code/Codex 组合包 | 发布包提供原生能力，按需插件保持关闭；不自动开启实验性插件或安装外部组合包 |

上述边界按本项目入口列出适配情况；未启用的独立原生客户端功能不计为已完成 Workbench 界面迁移。

HTML 预览在父页面通过认证读取同目录资源，再装入没有同源权限的脚本 sandbox；支持普通脚本、模块静态/字面量动态 import、CSS 引用及图片。认证信息不进入预览页面。任意运行时计算的相对 fetch 地址不作静态重写；复杂应用可以下载后在完整服务环境打开。

## 新对话与目录规则

- 顶部新对话按原生 `UiWorkspaceService.startSession` 规则，优先当前 Workspace，否则选择最近 Workspace。分组内新建显式指定该组；未分组新建显式不选择 Workspace。
- 新对话立即显示本地“新对话”占位行。未输入文字、附件或资源选择的空占位在切换时移除；未发送的输入保留，发送后才创建后台会话并以首条消息暂命名，随后接收原生标题。
- 默认新任务目录：`/workspace/conversations/YYYY-MM-DD/<chat UUID>`；历史会话保留已有目录。
- 手选 Workspace 直接作为 cwd；所有成员会话共享该目录。文件树显示实际目录名称，不以成员会话标题替代 Workspace 文件夹。
- Codex 公开 app-server 协议的 `Thread.cwd` 是绝对路径。日期目录由本项目按用户要求实现，未将 GitHub 用户问题中的桌面示例当成公开实现源码。

## 部署与恢复

MCP 与技能的内部状态统一归入资源目录：旧根目录的 `.mcp-settings.json`、`.mcp-pins.json`、`.mcp-cache`、`.mcp-backups` 分别迁入 `mcp/.settings.json`、`.pins.json`、`.cache`、`.backups`；技能开关、置顶、备份迁入 `skills/.settings.json`、`.pins.json`、`.backups`。单一 `resource_directory` 入口通过 owner descriptor/no-follow 与目录锁执行同文件系统迁移，保留冲突原始数据，迁入后移除旧条目。已安装包路径及 revision 保持不变；两个资源根文件夹允许查看与 ZIP 下载，文件接口拒绝删除根目录。

迁移前先 drain/fence 全部旧 Host 任务与 MCP 监督进程，确认旧 helper 已退出；随后备份持久化状态，替换 manager/Host，并在重新开放请求前以 UID 1000 调用同一个迁移入口，逐 owner 核对七个旧条目不存在、原始字节及权限保留。回滚必须恢复与旧 helper 配套的旧布局备份，只回滚镜像不能恢复设置权威。

适配器使用 Cordis `ctx.get('schedule')` 读取后启动的原生服务，避免引入启动依赖环；内部 Workspace 校验和引用搜索不读取定时目录。原生沙箱终端与定时目录的完整 HTTP 操作纳入 `smoke-host-bootstrap.mjs`。原生定时投递的实时事件和恢复路径都等待首次确认的 MCP 目录，后台子任务延续原冻结权限；文件删除同时检查后台子任务，私有会话目录删除等待有时间上限的原生活动结束。

原生 Agent 在 `agent/pre-step` 之前已执行 `SystemPrompt.assemble`。首次目录尚未确认的定时 claim 暂存在当前 Agent 的弱映射，原生 assembly waterfall 可取消地等候目录后绑定同一次已领取消息、刷新 MCP 范围限制，再由原生 `SystemPrompt.assemble` 重组一次；不重领消息、不复制 Native/PTC 工具模型。真实已发布 Agent 测试覆盖首轮工具和提供方目录、`complete:true` 提示词权威、平台提示词只读取一次以及等待期间取消。

数据库无新增字段或 SQL 迁移。部署顺序为后端受控路由、237 Host/Sandbox 成对升级并更新 SSH helper hash、235 前端。保持 owner、Workspace、home volume 与目录不变，通过现有 drain/fence/replace 流程升级，不强停正在运行的任务。

上线前备份 manager 状态、原生会话、Workbench SQLite、配置及 owner 持久卷；在新镜像中对历史会话副本做读写重开验证。回滚使用此前镜像、helper hash、部署配置和备份；新建定时任务数据须随原生 JSON domain 一起保留。

本文件列出验证入口，不代替具体运行结果。每轮的实际测试数、CI、镜像 SHA、部署和持久化检查结果记录在对应 PR 与部署产物中。

## 侧栏浏览器与后续交互

浏览器按 owner 和主对话绑定，人工侧栏与 `browser` 模型工具共用同一个沙盒 Chromium。模型只能通过已准入的运行操作其所属主对话浏览器，返回有界网页文本、元素选择器与当前焦点；没有任意 JavaScript 执行参数。侧栏收到运行提示后打开对应标签。切换对话只断开像素观察，显式关闭标签才关闭浏览器；闲置进程由既有生命周期回收。

侧栏主显示使用 KasmVNC 1.5.0 的 RFB 增量画面，AI 与用户操作同一沙盒内的可见 Chromium。Xvnc 仅监听沙盒 loopback，显示数据经既有签名 HTTP/SSE 和 owner SSH 通道按序传递；连接变慢或观察窗口关闭时，只释放显示连接。键盘、中文输入和鼠标控制共用有序输入队列，显式关闭浏览器标签才销毁该对话的浏览器。旧前端或旧沙盒仍可使用 CDP 截图兼容路径。浏览器操作、显示流、原生 Agent 准入和取消必须一起验证；独立探针通过不能代替上线后的授权链路验收。

Office 与浏览器共享沙盒字体。私有字体归档和字体镜像不随 Git 提交，生产沙盒构建须明确传入 `WORKBENCH_FONT_IMAGE`，并核对字体清单、`fc-list` 及预览 PDF 的字体嵌入结果。公共 CI 的系统字体构建只验证通用运行能力，不证明私有字体已进入生产镜像。

文件变更记录适配器同时声明原生 `subprocess` 和 `fs` 注入，写入/编辑意图通过真实 Cordis 作用域验证。分叉回复只返回运行状态，完整历史保留在原生事件和 SQLite，通过分页读取；本地临时分叉行继承原工作区，等待原生归属刷新。关联定时任务的对话在归档前要求先删除定时任务。
