# 现有 Host 的原生配置升级

新镜像首次启动保留原生用户设置，并从旧镜像的精确平台基线移除继承配置。持久目录中已有 `cordis.patch.yml` 的 Host，必须在换代前准备基线与证明；直接切换镜像会因缺少证明拒绝启动。

1. 排空所有者的原生任务和设置写入，记录原 Host 的不可变 Docker image ID、代际、用户配置及凭据文件摘要，备份持久目录。不要重新运行旧 entrypoint，它会覆盖用户配置。
2. 旧 entrypoint 复制的是构建生成的 `/opt/workbench/profiles/workbench/cordis.runtime.patch.yml`，其中包含追加的原生预设。静态 `cordis.patch.yml` 和用户当前文件均不能充当旧平台基线。
3. 先使 Manager 使用支持 `profile-upgrade` 维护动作的本次版本。再在具有 Docker 权限的宿主机上，从本次审核源码运行正式入口，使用原 Host 的注册身份、不可变 image ID、原 home volume 和实际 UID/GID；候选新镜像也必须使用完整 image ID：

```sh
python3 scripts/prepare-profile-upgrade.py \
  --old-image "sha256:<原 Host 的 image ID>" \
  --candidate-image "sha256:<候选新镜像的 image ID>" \
  --owner-id "<原 owner>" --home-volume "<原 home volume>" --user 1000:1000 \
  --workspace-id "<原 workspace UUID>" --generation "<原 generation>" \
  --instance-id "<原 instance_id>" --manager-container gxzs-sandbox-manager
```

该入口通过 Manager 内的 loopback root 请求持久冻结原 owner，不导出 Manager token。未知活动或忙状态只进入 draining，不写 home；成功后 state=fencing 阻止 ensure、维护恢复和新任务重启旧 entrypoint。准备期间不能推进 replace，失败也不自动解除屏障；重试复用原维护 token，完成后保持 fencing，供后续正式 replace 推进新代际。

入口核对冻结返回的 owner/代际/实例/image/home 与原注册身份一致，并核对 volume owner 标签、无运行挂载及实际目录 UID/GID。它从指定旧 image 的永不启动容器直接读取运行时补丁，内容与来源 ID 不能由调用方分别配对。再以原 UID/GID 在可识别的候选容器中校验 YAML，原子写入基线与证明，不修改用户配置或凭据；候选在成功、失败、超时后均强制移除，然后才完成维护动作。相同输入可重试，已有不同基线或身份拒绝覆盖。

4. 在已停止且仍受 fencing 保护的原目录上完成新鲜备份，确认用户配置及凭据摘要与步骤 1 一致，再通过正式 replace 启动新镜像。首次迁移在原生文件锁内完成；迁移前备份先写临时文件并 fsync，再通过不覆盖既有文件的原子发布保存为 `.cordis.patch.before-bundle-layout-v1.yml`，随后写布局标记。检查 removed/retained 和保留的模型设置，不输出凭据值。重复启动保留用户设置。
5. 验证 Host ready、原生会话、模型凭据状态、文件/Office、浏览器和终端。失败时停止该 owner 的新运行时，保全当前目录和步骤 1 的备份，核对差异后修复。若需使用原镜像恢复，必须采用受控启动并还原、核验原生用户设置；仅还原卷再启动旧 entrypoint 仍会覆盖设置。

新建空持久目录无需旧基线。每个已有 owner 单独执行，不共享其他用户的迁移证明。
