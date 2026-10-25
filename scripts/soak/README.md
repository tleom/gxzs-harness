# 不调用付费模型的原生运行验收

这里的服务实现 OpenAI Chat Completions 流式接口，按场景返回确定的工具调用。
它没有上游模型地址或转发逻辑，不加载生产模型凭据。终端、浏览器、文件、
技能、MCP、子智能体、后台任务、定时任务、Goal 和排队由真实 DSH/Manager 执行。
只有读到实际工具结果并通过场景断言，服务才推进下一步。

`platform.mjs` 模拟 Java 平台边界。此套测试不能替代生产 Java HTTP、登录权限、
真实模型供应商或真实外部插件验证；这些边界需要单独测试。
空定时目录仅确认没有待登记计划；非空预唤醒登记返回拒绝，由真实 Java/SnailJob 测试栈验证持久化登记与到期执行。

## 创建独立测试栈

脚本针对 SSH 237 的现有 Docker 部署，执行前核实资源、地址池和端口。
每次使用新的 `/home/jrgx/gxzs-simulated-soak-*` 目录；默认复制生产的镜像 ID 和资源限制，
所有测试身份、凭据、网络、状态和数据卷独立，不写生产用户表。

```sh
python3 stack.py up --root /home/jrgx/gxzs-simulated-soak-example
python3 stack.py owners --owners 30 --root /home/jrgx/gxzs-simulated-soak-example
python3 run.py fixtures --owners 30 --root /home/jrgx/gxzs-simulated-soak-example
python3 monitor.py --minutes 240 --root /home/jrgx/gxzs-simulated-soak-example
# 另一个终端：30 个独立身份同时提交 120 个原生任务。
python3 run.py soak --owners 30 --minutes 120 --case example --root /home/jrgx/gxzs-simulated-soak-example
```

`--minutes` 是其中一个任务的最短执行时长，其余任务最少执行 20 分钟。
排队等待不计入执行时长。最多允许 15 个活跃用户，每用户最多同时运行 3 个任务，不另设全局任务数上限。
目录中已有同名任务时拒绝重新提交。观察进程退出后，可继续读取原任务：

```sh
python3 run.py resume --owners 30 --minutes 240 --case example --root /home/jrgx/gxzs-simulated-soak-example
python3 terminal_check.py --root /home/jrgx/gxzs-simulated-soak-example
```

`resume` 只轮询已有任务，不创建聊天、不重复提交。不要与原观察进程同时运行。
事件文件采用追加写入；恢复读取时以事件 ID 去重。
提交清单必须与完整准备清单一致；提交途中退出时，先调查已被接收的任务，不能把残缺清单当作完整压测。
验收同时要求原生任务结束、所有事件页读取完成及派生任务完成。
`mixed` 场景 ID 最长 48 字符，定时投递场景最长 55 字符，为派生任务预留后缀；其他场景最长 64 字符。
`soak` 会给基名附加用户和通道编号，因此基名最多 41 字符。所有生成名称在创建聊天前校验。

候选验证支持 `--host-image`、`--sandbox-image`、`--manager-image`、`--account-names`。
`--global-skills-dir` 可指定已核验的宿主机技能目录，让测试 Host 和 Sandbox 只读挂载同一资源；
测试平台按该目录生成合成的 `global_skills` 发布清单，`id` 使用技能目录名，`order_num` 为 0；未挂载时发布空清单。
候选 SSH helper 的哈希从指定镜像读取，Host 与 Sandbox 必须一致。
多个测试栈必须指定不重叠的 `--pool` 和不同的 `--model-port`、`--manager-port`。
名字验证使用独立 `GXZS_RUNTIME_PREFIX`，不会占用生产的 `gxzs-host-admin` 等名称。

## 单场景与故障

`run.py pilot --case-file scenario.json --root ...` 支持完整场景对象。
`kind` 包括 `chain`、`mixed`、`schedule-delivery`、`goal`、`browser-recovery`。
`largeArguments` 和 `argumentChunkSize` 验证大参数、Unicode 和分片；`fault` 可配置
`mode=http429|http503|http403|disconnect`、`step`、`count`，验证重试和部分流断开。
429 响应携带 `Retry-After: 1`；夹具不会转发到真实模型。
`/__test/fault` 可注入有界的平台目录/配置/准入 503，接口要求本栈凭据。

报告包含任务及事件清单、工具执行记录、资源和准入采样。验收时核对文件落盘、
任务/子任务终态、排队上限、故障恢复与日志；不能只看 `paidModelCalls` 或完成计数。
模拟服务本身的故障、预期拒绝和产品缺陷分别记录。

私有清单、凭据和原始事件留在任务目录，不能提交仓库。清理只允许使用本栈
清单中的确切容器/网络/卷，先确认无任务执行，再停 Manager，防止回收后自动重建。
禁止对共享主机使用全局 `docker system prune` 或 `volume prune`。
