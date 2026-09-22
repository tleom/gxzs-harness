# 用户沙盒执行链路检查与修复

检查时间：2026-09-21 至 2026-09-22，目标主机 SSH 别名 `237`。本次操作未涉及 235、业务数据库或用户已有文件修改。

## 根因

在 `gxzs-migration-host-0` 的实际安装包中调用 `runRipgrep`，通过真实 SSH provider 复现 `glob` 和 `grep` 的 `SEARCH_FAILED`。两者的原始 cause 均为：

```text
spawn /srv/dsh/profiles/workbench/node_modules/@vscode/ripgrep-linux-x64/bin/rg ENOENT
```

搜索工具在 DSH host 解析了自身 `@vscode/ripgrep` 的绝对路径，然后由 SSH provider 原样传到用户沙盒。两个用户沙盒已有 `/usr/bin/rg`（13.0.0）和 `/opt/dsh/node_modules/@vscode/ripgrep-linux-x64/bin/rg`（15.0.0），缺少的是 host 对应路径，因此重新安装 rg 本身无法修复。

同时复现两项执行环境不一致：默认 `spill-local` 将大输出写到 host 临时目录，但读取提示使用指向沙盒的 read/grep；默认 PTC 引导文件路径无法映射到 SSH 执行环境，返回 `PTC runtime bootstrap is unavailable in the subprocess execution world`。

## 已执行的在线环境修复

仅在两个既有用户沙盒中新增兼容软链接：

```text
/srv/dsh/profiles/workbench/node_modules/@vscode/ripgrep-linux-x64/bin/rg
  -> /opt/dsh/node_modules/@vscode/ripgrep-linux-x64/bin/rg
```

没有挂载 host 文件系统，没有覆盖已有文件，也没有重启在线 Agent。该兼容路径在当前容器重启后仍存在，但容器重建时会丢失；长期修复由本次新增的 Workbench 适配包提供。

回滚此环境修复时，只在核对上述链接目标后移除本次新增的链接，保留沙盒已有 rg 和其他目录。当前无需回滚。

## 代码修复

- 新增 `@gxzs/dsh-workbench-sandbox-runtime/subprocess`：初始化时在远端解析 rg，只映射上游搜索工具的精确可执行文件路径，其余执行语义交给原 SSH provider。
- 新增 `@gxzs/dsh-workbench-sandbox-runtime/spill`：通过 SSH 文件系统将完整输出原子写到 `/workspace/.agent-output/<session-hash>/<random-id>.txt`，写入失败直接报告，不回退到 host。
- Workbench profile 禁用 `spill-local`，配置远端 rg，并将 PTC 的 Node 和引导文件指向沙盒的现有运行环境。
- 更新工作区及部署 profile 的锁文件、配置检查入口和部署说明。上游 DSH 源码未修改。

## 验证结果

隔离副本位于 `D:\Documents\gxzs\temp\sandbox-search-audit\harness-check`。语法检查、plugin 检查和配置装配检查通过；完整 Vitest 共 20 个文件、139 个测试通过，包含 5 个新增测试。`git diff --check` 通过。

在两个真实 owner host 中启动独立诊断进程，使用各自现有的 SSH 身份连接对应用户沙盒，未替换在线服务配置。以下验证通过：

| 项目 | 结果 |
| --- | --- |
| 原始 glob/grep 经兼容路径执行 | 两个沙盒均恢复 |
| write/edit/read/listDir | 读写同一个沙盒测试文件；host 不存在该文件 |
| grep 有匹配及零匹配 | 分别返回成功匹配和正常空结果 |
| shell 文件与执行身份 | 看见沙盒测试文件，返回对应沙盒 hostname |
| 两个用户间测试文件隔离 | 仅能看到各自标记文件 |
| host 控制数据路径 | 沙盒文件接口看不到 `/srv/dsh/workbench.sqlite3` |
| 新 subprocess provider | 实际执行 `/usr/bin/rg`，不依赖兼容软链接 |
| 新 spill provider | 沙盒文件存在、host 同路径不存在；read/grep 回读成功；权限 0600、UID/GID 1000 |
| 显式 PTC bootstrap | 两个沙盒均执行成功，返回 cwd `/workspace` |

这些检查验证了此次涉及的 provider 和执行链路，不等同于所有可选工具、浏览器端或完整真实模型任务的穷尽验收。

## 交付与上线边界

代码保留在用户指定的 `fix/human-input-lifecycle` 当前分支，已有其他修改未回退。尚未提交、推送或创建 PR。新增适配包与 profile 尚未替换在线服务，独立诊断成功不能视为已经部署。

正式启用时应备份每个 owner 的 profile 和依赖锁文件，安装新增包，应用本次三个执行环境配置变更，在没有活动任务时逐个重新加载或重启 owner host，再重复以上链路检查。部署时保留现有其他配置，不能用未经核对的整个本地 profile 覆盖在线 profile。异常时恢复备份并重新启动原版本；本次兼容路径可继续保障搜索工具。

用户文件、目录、命令和程序执行的目标为用户沙盒。会话数据库、模型凭据、服务日志和附件缓存属于控制服务内部数据，仍由 host 管理。对外 MCP/平台服务请求遵循各自的 owner 认证边界；不应将这些控制数据暴露为用户文件操作路径。
