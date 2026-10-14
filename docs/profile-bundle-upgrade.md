# 现有 Host 的原生配置升级

新镜像首次启动保留原生用户设置，并从旧镜像的精确平台基线移除继承配置。持久目录中已有 `cordis.patch.yml` 的 Host，必须在换代前准备基线与证明；直接切换镜像会因缺少证明拒绝启动。

1. 排空所有者的原生任务和设置写入，记录原 Host 的不可变 Docker image ID、代际、用户配置及凭据文件摘要，备份持久目录。不要重新运行旧 entrypoint，它会覆盖用户配置。
2. 从该旧 image 的 `/opt/workbench/profiles/workbench/cordis.patch.yml` 提取平台基线。使用未启动的临时容器与 `docker cp`，不要使用用户当前的 `cordis.patch.yml` 充当基线。记录提取文件的 SHA-256，私有文件按 `0600` 保存。
3. 使用候选新镜像的一次性容器，以持久目录的原 UID/GID 挂载原 `DSH_HOME`，并将基线只读挂载。传入该目录的原 `GXZS_HOST_OWNER_ID`，覆盖 entrypoint 为 `node`，执行：

```sh
node /opt/workbench/scripts/migrate-platform-patch.mjs \
  --seed-legacy-baseline /run/legacy/cordis.patch.yml \
  "sha256:<原 Host 的 image ID>" "<提取文件的 SHA-256>"
```

此生产入口校验基线内容摘要、YAML、image ID 和 owner，写入 `legacy-platform-baseline.patch.yml` 与 `legacy-platform-baseline.json`，不修改用户配置。相同输入可重试，已存在的不同基线或身份会拒绝覆盖。

4. 先确认用户配置及凭据摘要与步骤 1 一致，再启动新镜像。首次迁移在原生文件锁内完成，保存 `.cordis.patch.before-bundle-layout-v1.yml`，写入布局标记；检查 removed/retained 数量及保留的模型设置，不输出凭据值。重复启动保留用户设置。
5. 验证 Host ready、原生会话、模型凭据状态、文件/Office、浏览器和终端。失败时使用步骤 1 的一致备份及原镜像恢复，不把已转换的用户层直接交给会覆盖配置的旧 entrypoint。

新建空持久目录无需旧基线。每个已有 owner 单独执行，不共享其他用户的迁移证明。
