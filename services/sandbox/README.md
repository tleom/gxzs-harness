# Owner sandbox image

在仓库根目录构建：

```bash
docker build --build-arg VCS_REF="$(git rev-parse HEAD)" -f services/sandbox/Dockerfile -t gxzs/harness-sandbox:<revision> .
```

镜像以不可变的 Dify sandbox 基础镜像为底座，保留其 `shellctl` 兼容入口。DSH helper 与 PTC 的依赖来自本仓库 `profiles/workbench/package-lock.json`，与 host 同版。Node、Office 和 MCP 运行目录均归 root 所有，任务以 UID 1000 运行。管理脚本固定使用隔离的系统 Python；个人依赖继续放在 `/opt/user-env`。

`entrypoint.sh` 为每个 owner 在 home 卷生成 SSH host key，在 2222 监听。初始空 `authorized_keys` 拒绝所有登录；manager 随后写入该 owner 的公钥，并读取同一个 home 内的 host key。入口不忽略 sshd 启动失败。Docker 的 liveness 仅检测 SSH 可达；任务就绪还需 manager/host 的完整 readiness。

Office 构建源来自 237 上的 `workbench-pending-pr-20260916/workbench/sandbox-office`；Mermaid 包装器与锁文件来自 `deploy-main-20260917-2feccd34ec` 的对应目录，于 2026-09-22 纳入本仓库。MCP 锁文件来自同日实际 owner sandbox 的 `/opt/workbench-mcp`，版本为 `mcp==2.2.0`。Python/Node 锁文件保留既有能力，浏览器统一采用 Debian Chromium，并提供原有 `google-chrome` 路径兼容。

Office 使用系统 Noto CJK 等字体；部署前应核对历史文档对自定义字体的依赖。系统包列表保存在镜像 `/opt/office/system-packages.txt`。构建时验证必要解释器和工具；`scripts/smoke-images.sh` 在无外部网络、无额外 capabilities 的容器中验证 SSH、中文 Word 转 PDF、不可写运行时和无 Docker socket。该验证不需要模型密钥。

镜像升级必须通过 host 的 drain/fence/replace 协议，保留 workspace/home/env 卷。发布时记录镜像 ID、仓库 digest、源码 revision、profile lock 摘要和 helper 摘要，部署使用已核对的 digest。构建通过不表示已部署。
