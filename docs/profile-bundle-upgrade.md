# 现有 Host 的原生配置升级

新镜像首次启动保留原生用户设置，并从旧镜像的精确平台基线移除继承配置。持久目录中已有 `cordis.patch.yml` 的 Host，必须在换代前准备基线与证明；直接切换镜像会因缺少证明拒绝启动。

1. 排空所有者的原生任务和设置写入，记录原 Host 的不可变 Docker image ID、代际、用户配置及凭据文件摘要，备份持久目录。不要重新运行旧 entrypoint，它会覆盖用户配置。
2. 旧 entrypoint 复制的是构建生成的 `/opt/workbench/profiles/workbench/cordis.runtime.patch.yml`，其中包含追加的原生预设。静态 `cordis.patch.yml` 和用户当前文件均不能充当旧平台基线。
3. 在具有 Docker 权限的宿主机上，从本次审核的源码运行以下正式入口，使用原 Host 的不可变 image ID、原 home volume、owner 和 UID/GID；候选新镜像也必须使用完整 image ID：

```sh
python3 scripts/prepare-profile-upgrade.py \
  --old-image "sha256:<原 Host 的 image ID>" \
  --candidate-image "sha256:<候选新镜像的 image ID>" \
  --owner-id "<原 owner>" --home-volume "<原 home volume>" --user 1000:1000
```

该入口核对 volume 的 owner 标签，拒绝仍被运行容器使用的 home。它从指定旧 image 创建永不启动的临时容器，检查容器实际 image ID，并通过 Docker 直接读取运行时补丁；内容、摘要和来源 image 来自同一次提取，不能由调用方分别配对。临时容器随后删除。入口再以原 UID/GID 在候选镜像的一次性容器中校验 YAML，并原子写入 `legacy-platform-baseline.patch.yml` 与含来源路径的 `legacy-platform-baseline.json`，不修改用户配置或凭据。相同输入可重试，已有不同基线或身份会拒绝覆盖。旧版自由指定文件与 image 的 Node CLI 已停止接收。

4. 先确认用户配置及凭据摘要与步骤 1 一致，再启动新镜像。首次迁移在原生文件锁内完成，保存 `.cordis.patch.before-bundle-layout-v1.yml`，写入布局标记；检查 removed/retained 数量及保留的模型设置，不输出凭据值。重复启动保留用户设置。
5. 验证 Host ready、原生会话、模型凭据状态、文件/Office、浏览器和终端。失败时停止该 owner 的新运行时，保全当前目录和步骤 1 的备份，核对差异后修复。若需使用原镜像恢复，必须采用受控启动并还原、核验原生用户设置；仅还原卷再启动旧 entrypoint 仍会覆盖设置。

新建空持久目录无需旧基线。每个已有 owner 单独执行，不共享其他用户的迁移证明。
