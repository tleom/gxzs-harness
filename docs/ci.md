# CI 验证范围与运行成本

CI 使用 GitHub 托管的 `ubuntu-latest`，由面向 `main` 的 PR 和手动运行触发。合并后不再重复运行。工作流只验证代码和临时镜像，不发布镜像、不部署服务。

`main` 已启用分支保护：必须通过 PR，最新基线上的 `verify`、`manager`、`images` 检查必须通过且来自 GitHub Actions，全部讨论须解决，审批人数为 0。规则同样适用于管理员，禁止强推和删除主分支。修改这些规则前须重新确认 CI 的覆盖范围。

## 三个检查任务

| 任务 | 验证内容 |
| --- | --- |
| `verify` | CI 范围选择测试、文档检查、锁定依赖安装、DSH skill catalog 补丁及校验、语法/单测/模拟器/插件检查、真实 DSH 配置解析、四个生产 npm 锁树的依赖审计 |
| `manager` | Python Manager、真实固定版本 memory engine、Linux MCP transport 测试；与 `verify` 并行 |
| `images` | 前两项通过后构建 Host、Manager、Sandbox 三个镜像，执行完整的原生运行时、浏览器、Office、SSH、容器隔离及生命周期冒烟 |

依赖审计合并到已经准备好 Node 的 `verify` 中，避免独立 Runner 重复检出和安装 Node。仍沿用既有策略：漏洞发现写入日志和摘要，审计执行错误阻断检查。

只有 PR 的变更全部属于根目录 `README.md` 或 `docs/` 下的 `.md` 文件时才使用轻量路径：检查文档 UTF-8、差异空白及冲突标记，运行 CI 范围选择测试，跳过依赖安装、运行测试和镜像构建。包内 README、脚本、锁文件、配置、CI 文件及未知路径均运行完整检查。重命名按删除和新增两条路径判断，不能用将代码移到文档目录的方式漏掉验证。手动运行、无法比较的历史和空差异也始终运行完整检查。文档 PR 的 `images` 任务报告为跳过，GitHub 允许这种任务级跳过满足必需检查；不能改成跳过整个工作流，否则必需检查会一直等待。

## 镜像缓存

三个镜像分别使用 GitHub Actions 的 BuildKit 层缓存，scope 为 `harness-host`、`harness-manager` 和 `harness-sandbox`，避免相互覆盖。缓存按 Dockerfile、构建上下文和参数的实际输入失效；本次提交的 `VCS_REF` 标签仍参与构建。镜像通过 `load: true` 装入本次 Runner 的 Docker，`push: false`，随后完整执行原有 [smoke-images.sh](../scripts/smoke-images.sh)。缓存命中不会跳过任何冒烟。

BuildKit 构建区和加载后的冒烟镜像会同时占用磁盘。镜像任务在临时 GitHub Runner 中先清理未使用的 Android、.NET 和 GHC SDK，并记录前后磁盘及 Docker 用量；清理步骤限定为 GitHub 托管 Runner，保留 Node、Python 和 Docker。首次实跑曾因空间不足退出，因此缓存流程的验收同时包含空间检查。

仅在 `main` 手动运行 Verify 时更新共享缓存，PR 只读取缓存，避免每个 PR 上传三套大型缓存。2026-10-20 已建立三套缓存并验证读取；依赖锁文件、基础镜像或 Dockerfile 更新合并后，如需建立新基线缓存，可手动运行一次 `main` 的 Verify。普通源码修改不要求额外运行，变化的层会按输入重新构建。缓存缺失时正常冷构建；缓存写入错误会使任务失败，不伪装为验证通过。实现依据 [Docker GitHub Actions 缓存文档](https://docs.docker.com/build/ci/github-actions/cache/)。

## 本地检查与性能证据

```bash
python3 -B -m unittest discover -s .github/scripts -p 'test_*.py'
```

修改工作流后还应运行 YAML/Actions 静态检查，并在获得提交和推送授权后核对 GitHub 实际运行。运行代码、镜像和生产验收命令仍见 [README](../README.md) 和 [部署配置](deployment-environment.md)。

优化前样本：[2026-10-19 主分支运行](https://github.com/tleom/gxzs-harness/actions/runs/39319277973)，整体约 14 分 37 秒，其中镜像任务 12 分 11 秒、构建步骤 8 分 18 秒、冒烟 3 分 46 秒。[2026-10-20 缓存验证](https://github.com/tleom/gxzs-harness/actions/runs/39356238368/attempts/2)仅复跑镜像任务：完整任务 9 分钟、构建步骤 3 分 59 秒，所有冒烟通过，结束剩余 20 GB 磁盘。单次镜像任务样本减少约 26%；网络、Runner 和具体改动会影响实际收益，首次缓存建立不代表日常命中耗时。纯文档 PR 使用轻量检查，代码 PR 合并后也不再重复完整验证。
