# DSH alpha.5 升级核查

目标为上游 `dsh-v0.2.1-alpha.5`，源码提交 `1517a4dbca0a2789ff1d41ba439600f8547d23fa`。对比基线是生产部署的 alpha.2；同时核对 Git 标签差异和实际安装的 npm 包，避免把源码标签当作发布包的完整证明。

## 上游变化与适配

| 变化 | 影响与处理 | 验证入口 |
| --- | --- | --- |
| Terminal 的 follow/write/resize 改为 attach 双向流 | 由原生 Gateway 创建带 Peer 的连接，HTTP 输入分配顺序号并等待原生 ACK；断线或确认超时不重放输入；保留工作台现有控制者显示字段 | terminal-uplink、terminal-tool、sidebar-gateways 与镜像真实 PTY |
| 原生客户端图新增 release 身份 | Host 返回完整 release；前端兼容 alpha.2 和 alpha.5，校验新图的版本；图修订摘要包含 release | native-client 与镜像实际模块执行 |
| client-store 发布清单遗漏运行依赖 | profile 显式安装与前端相同的 Zustand 4.5.7、Immer 10.1.1；补齐生成客户端所需的 ui-primitives、client-store | check-runtime-imports、原生客户端装配 |
| JSONL persistence 改为命名插件导出 | 更新测试和历史会话检查器的导入方式；生产继续由原生 Loader 加载 | cold-restore、compaction-cold-restore、smoke-session-upgrade |
| Session.create 对已开始的会话可能生成新 ID | 合并同会话的并发初始化；历史会话仍走 resolveAgent；创建结果必须等于绑定 ID | service、并发冷读取镜像验证 |
| SessionCommandController.prompt 接收 MessageSource | 内部测试显式传入 user/rpcId；生产仍调用公共 SessionController | native-lifecycle、skill-selection-lifecycle |
| 子智能体独立预设和冷恢复代码变化 | 重定位重复提交保护锚点，保留上游预设恢复逻辑 | subagent-prompt、冷恢复及生命周期测试 |
| Goal 等待正在执行的后代再驱动下一轮 | 保留原生实现，验证等待时不增加模型请求，暂停仍生效 | native-lifecycle 的 descendants 回归 |
| 关闭计划审核直接结束本轮 | 保留原生 concludesTurn，验证工作台回执完成且不再请求模型 | native-lifecycle 的 plan review 回归 |
| pi-ai 依赖范围允许额外升级 | 固定官方 alpha.5 锁文件使用的 1.1.0；npm 安装显式应用上游六种接口的流式参数优化 | stream-argument-preparation |
| 凭据优先级改为保存文件优先于环境 | 升级前逐 owner 检查新解析器及环境冲突，不输出凭据值 | 生产只读预检 |
| 后台任务 ID 改用随机标识、增加持久事件 | 工作台按字符串透传 ID，不依赖数字序号；原生状态仍是完成依据 | jobs、history、native-lifecycle |
| JSONL 列表共享并发限制及关闭时排空 | 保留上游实现，复验历史读取、冷恢复和受控重启 | cold-restore、smoke-session-upgrade、镜像重启验证 |
| PTC 增加可选持久执行模式 | 默认仍为 per-call，本次不启用新的常驻执行模式；Host 和 Sandbox 同步更新 bootstrap/helper | smoke-native-sandbox-tools |
| SSH helper 入口、Linux scope 探测调整 | Host/Sandbox 使用同版依赖及 helper 摘要；保留租约和资源隔离 | smoke-native-ssh 的并发、取消、断线、清理验证 |
| Skill、MCP、原生设置、引用目录变化 | 保留平台授权、发现快照、显示名及调用身份规则；补丁校验严格匹配 alpha.5 | discovery、skills、native-settings、references |

alpha.3 的会话持久化、子智能体、Goal 和凭据变化，alpha.4 的预设、推理配置、插件兼容性及终端状态变化，以及 alpha.5 的终端发现共享、技能菜单刷新、PTC 提示词等修正均纳入接口核对。上游桌面安装器、原生账户界面及未挂载的实验模块不作为 GXZS 已启用功能验收。

## 稳定性约束

升级保留平台准入续租、短暂 503 恢复、真实失效代次隔离、冻结工具权限、目录刷新去重、Agent inbox 恢复、长流式参数处理和浏览器超时后的可读页面判断。模型、供应商地址和 owner 凭据不因升级替换。

回归使用模拟模型和隔离 Host/Sandbox；付费模型只用于必要的有限生产验收。通过有限测试不等于证明无限时长或任意并发下不会故障。

## 部署与回退

1. 前端先部署同时兼容两个版本的客户端，再升级 Harness；已打开的旧页面需要刷新才能使用新客户端。
2. 等待最新提交的 CI 和审核。保存实际部署镜像 ID、配置摘要和每个 owner 的代次、旧镜像及 home 卷。
3. 保留正在运行的任务，按原生活动与准入状态排空。现有目录按 `profile-bundle-upgrade.md` 处理，禁止绕过忙状态强行换代。
4. 验证新旧历史、原生客户端、终端、技能/MCP、后台任务/定时任务、Host/Sandbox 版本与 helper 一致性及日志。
5. 回退也必须排空、核对 owner 配置及目录差异，并使用已记录的旧镜像与备份；不得重放未知是否已执行的工具调用。

此文档描述升级约束与验证入口。生产完成状态以本次部署回执、镜像身份和运行验证结果为准。
