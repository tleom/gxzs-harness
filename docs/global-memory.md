# 全局记忆

“全局记忆”（英文名 `global memory`，内部标识 `global-memory`）注册在现有 `gxzs_ai_mcp_global`，与联网搜索、法律检索使用相同的发布、启停、工具选择和任务授权链路。前端不增加独立入口。全局是能力的提供范围；每个用户的数据仍在自己的沙盒中。

唯一专用运行文件是 `services/sandbox-manager/global_memory.py`。它将已授权的调用送往平台为当前用户确定的沙盒，并复用 dsh-memory 原生 MCP 的 `cg`、`stg` 工具定义和执行入口，不复制其记忆算法。工具参数不能设置用户身份或记忆根目录。上游固定为 v0.8.1（`32ac237fb56afa43f73d668f1dfe9b306d71b025`），安装时包含 `md_cg`、启动依赖 `utf8_boot.py`、版本元数据 `package.json` 和 MIT LICENSE。

数据和用户独立令牌保存在沙盒 `/home/gxzs/.gxzs-global-memory`，使用已有的用户 home 持久卷，更新程序不删除数据。程序放在 root 管理的 `/opt/gxzs-global-memory/<revision>`。临时进程重建会读取同一份记忆。

v0.8.1 默认把改写、遗忘送入独立审核队列。平台使用上游 `MDCG_AUTONOMY=full` 配置保留用户已授权操作的即时执行语义；原有用户令牌、允许操作/记忆层、内容规则及原生写入验证仍然生效。此接入仅提供 MCP 工具，没有启用上游 DSH 插件的自动记录或上下文注入。

`cg(op=write)` 使用上游原生写入审核流程；`ok=true` 不一定代表记忆已落盘，必须检查 `committed=true`。待审核内容不能报告为“已经记住”。普通文本使用基本凭据排除规则，不把该规则当作法律合规审查。任务提示要求只保存明确的长期偏好或已核实的可复用事实，不保存密码或完整聊天。

部署顺序：

1. 更新 sandbox-manager 和 DSH adapter；管理器镜像构建时安装固定版本的上游源代码。
2. 更新后端 `GlobalMcpService`、`McpPlatformService`。旧后端会忽略 `sandbox-memory` 类型。
3. 执行根工作区 `sql/migrations/20260922_global_memory.sql`，首次注册为停用，不覆盖现有记录。该 SQL 不属于任何仓库 PR。
4. 在目标环境核对用户隔离及持久化后，启用该注册记录。新任务按现有全局插件机制选择使用。

回滚时停用 `global-memory` 注册记录，保留用户数据和旧 profile 数据备份。升级工具清单时同时更新 `config_version`、`manifest_version` 和 `public_config_json.runtime_version`。

验证：`python -m unittest discover -s services/sandbox-manager/tests -p test_global_memory.py`。完整引擎测试需设置 `GLOBAL_MEMORY_TEST_SOURCE` 为固定版本的上游源目录，并在 Linux 运行；覆盖新进程读回、用户隔离、忘记、参数边界、授权失效和重试去重。
