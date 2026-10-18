# DSH preparation 与补丁登记

核对基线：`profiles/workbench/package-lock.json` 固定的 DSH `0.2.1-rc.2`；流式参数依赖 `@earendil-works/pi-ai@1.1.0`。本表说明当前代码为什么仍需这些适配，不表示已核查未来上游版本。升级时以实际 npm 产物和行为测试判定，不以版本标签相同代替内容一致。

`profiles/workbench/prepare-presets.mjs` 在 profile 安装时执行前八项；Host Dockerfile 在安装后另外执行终端侧栏准备、技能目录补丁与目录检查。源文件没有变化的本轮不重新修改这些补丁。

| 脚本 | 当前用途与输入约束 | 验证入口与撤除条件 |
| --- | --- | --- |
| `scripts/prepare-workspace-changes.mjs` | 保留原生变化捕获算法，生成注入 owner Sandbox I/O 的 `gxzs-sandbox.js`；核对 rc.2、profile/runtime 两份依赖版本、I/O import/导出和 captureFile 区段，拒绝遗留本地文件操作 | `packages/workbench-sandbox-runtime/test/native-changes.test.js` 及 changes 系列；上游能直接注入等价远程 I/O 且真实 Sandbox 捕获测试通过后移除 |
| `scripts/prepare-session-client.mjs` | 原生 prompt 复用调用方 requestId，防止重试产生新提交身份；核对 rc.2、prompt 签名和唯一替换点，识别已准备内容 | `packages/workbench-adapter/test/session-client-preparation.test.js`；未修改上游已保留 requestId 且重试幂等测试通过后移除 |
| `scripts/prepare-subagent-prompt.mjs` | 热/冷子会话按用户 rpcId 去重并保留 abort/admission 与历史归属；核对 rc.2 和热/冷入口唯一锚点 | `packages/workbench-adapter/test/subagent-prompt-preparation.test.js`；上游热/冷恢复均具备同等请求身份语义后移除 |
| `scripts/prepare-session-references.mjs` | 从已有 Session header 查询候选，不为只读查询创建活跃 Agent；核对 rc.2、候选方法和 cwd/id 引用，拒绝剩余 Agent 依赖 | `packages/workbench-adapter/test/session-reference-preparation.test.js`；上游公开等价 header 查询且权限/目录测试通过后移除 |
| `scripts/prepare-workbench-client.mjs` | 构建平台展示载体，复用原生纯 settings/controller 区段；辅助 `native-settings-controllers.mjs` 核对 rc.2、factory/region/常量边界并嵌入五份输入 SHA-256 provenance | `packages/workbench-adapter/test/native-client.test.js`、`native-settings.test.js`；这是平台构建步骤，只有平台展示载体替换或上游公开等价可导入控制器后再评估，不因版本升级直接删除 |
| `scripts/prepare-dsh-stream-arguments.mjs` | DSH消费原始参数增量，避免多个provider每次重新解析完整前缀；核对DSH rc.2消费者契约、pi-ai 1.1.0和每个provider唯一原始/已准备锚点 | `packages/workbench-adapter/test/stream-argument-preparation.test.js`；实际发布包已包含等价处理、各provider结束结果与规模回归通过后移除 |
| `scripts/prepare-dsh-agent-inbox.mjs` | Host正常dispose保留尚未领取的持久inbox，恢复可唤醒待处理消息；核对rc.2、cancel/keepInbox/whenIdle/wakeDriver及唯一方法形态 | `packages/workbench-adapter/test/agent-inbox-preparation.test.js`；未修改上游可通过退出/重启/取消边界与无重复领取测试后移除 |
| `scripts/prepare-terminal-cleanup.mjs` | Linux终端清理时先停止已验证shell再处理后代，防止持续产生替代进程；核对rc.2及清理区段边界/已准备标记 | `packages/workbench-adapter/test/terminal-cleanup.test.js`、真实SSH清理冒烟；上游能通过持续派生子进程清理测试后移除 |
| `scripts/prepare-sidebar-terminal.mjs` | Agent与UI复用原生PTY；内部write/inspect不抢UI follower，按owner约束配置并允许0表示不设数量限额；核对rc.2和每个新增方法/限额锚点 | `packages/workbench-adapter/test/terminal-tool.test.js`、`terminal-uplink.test.js`；上游支持等价内部操作和现行配置语义后移除。数量策略属于产品选择，不能按旧文档默认8推断当前值 |
| `scripts/patch-dsh-skill-catalog.mjs` | 原生技能目录保留平台displayName与技能展示契约；核对rc.2、唯一原始/已准备文本 | `scripts/check-dsh-skill-catalog.mjs`；锁定发布包原生包含等价字段与目录行为且检查通过后移除 |

每次升级在隔离安装中保留：锁文件的包来源/integrity、实际 package.json 版本、每项原始输入 SHA-256、准备脚本 SHA-256、准备后输出 SHA-256及相应用例/镜像冒烟结果。源形态匹配是现有构建门禁；完整输入/输出hash台账是升级证据要求，当前脚本没有统一自动生成全部hash的功能。原工作目录遗留 node_modules 不作为发布证据。

撤除补丁时同时移除安装/镜像入口、调用适配和失效检查，保留能够证明原问题不再复现的行为测试；不只删除版本校验来让新包通过。若匹配失败，先调查上游差异，不静默跳过。当前没有核实外部消费者的 `session-directory.js`、旧 planning/root环境入口另行盘点，不能因仓内调用较少直接删除。
