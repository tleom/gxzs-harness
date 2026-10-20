# CI 验证范围与运行成本

CI 使用 GitHub 托管的 `ubuntu-latest`，由面向 `main` 的 PR、`main` 推送和手动运行触发。工作流只验证代码和临时镜像，不发布镜像、不部署服务。

## 三个检查任务

| 任务 | 验证内容 |
| --- | --- |
| `verify` | CI 范围选择测试、文档检查、锁定依赖安装、DSH skill catalog 补丁及校验、语法/单测/模拟器/插件检查、真实 DSH 配置解析、四个生产 npm 锁树的依赖审计 |
| `manager` | Python Manager、真实固定版本 memory engine、Linux MCP transport 测试；与 `verify` 并行 |
| `images` | 前两项通过后构建 Host、Manager、Sandbox 三个镜像，执行完整的原生运行时、浏览器、Office、SSH、容器隔离及生命周期冒烟 |

依赖审计合并到已经准备好 Node 的 `verify` 中，避免独立 Runner 重复检出和安装 Node。仍沿用既有策略：漏洞发现写入日志和摘要，审计执行错误阻断检查。

只有 PR 的变更全部属于根目录 `README.md` 或 `docs/` 下的 `.md` 文件时才使用轻量路径：检查文档 UTF-8、差异空白及冲突标记，运行 CI 范围选择测试，跳过依赖安装、运行测试和镜像构建。包内 README、脚本、锁文件、配置、CI 文件及未知路径均运行完整检查。重命名按删除和新增两条路径判断，不能用将代码移到文档目录的方式漏掉验证。主分支推送、手动运行、无法比较的历史和空差异也始终运行完整检查。主分支不能仅根据最后一次 push 判断文档改动，否则它可能取消前一次尚未完成的代码验证，造成漏检。

## 镜像缓存

三个镜像分别使用 GitHub Actions 的 BuildKit 层缓存，scope 为 `harness-host`、`harness-manager` 和 `harness-sandbox`，避免相互覆盖。缓存按 Dockerfile、构建上下文和参数的实际输入失效；本次提交的 `VCS_REF` 标签仍参与构建。镜像通过 `load: true` 装入本次 Runner 的 Docker，`push: false`，随后完整执行原有 [smoke-images.sh](../scripts/smoke-images.sh)。缓存命中不会跳过任何冒烟。

仅 `main` 的推送或手动运行更新缓存，后续 PR 只读取缓存，避免每个 PR 上传三套大型缓存。缓存缺失时正常冷构建；缓存写入错误会使任务失败，不伪装为验证通过。实现依据 [Docker GitHub Actions 缓存文档](https://docs.docker.com/build/ci/github-actions/cache/)。

2026-10-20 核查时，Harness `main` 没有分支保护，所以保留主分支推送检查，覆盖直接推送。以后若启用强制 PR 和最新提交门禁，可以再评估取消合并后的重复验证；不能仅参照已启用主分支保护的其他仓库就直接移除。

## 本地检查与性能证据

```bash
python3 -B -m unittest discover -s .github/scripts -p 'test_*.py'
```

修改工作流后还应运行 YAML/Actions 静态检查，并在获得提交和推送授权后核对 GitHub 实际运行。运行代码、镜像和生产验收命令仍见 [README](../README.md) 和 [部署配置](deployment-environment.md)。

优化前样本：[2026-10-19 主分支运行](https://github.com/tleom/gxzs-harness/actions/runs/39319277973)，整体约 14 分 37 秒，其中镜像构建 8 分 18 秒、冒烟 3 分 46 秒。纯文档改动现在不需要这些运行检查；普通代码改动的缓存收益必须对比首次冷构建和后续缓存命中后的实际数据，不承诺未测得的节省比例。
