# 沙盒字体资产

Office 预览和沙盒程序共用 `/usr/local/share/fonts/workbench` 的字体及 fontconfig 索引。字体二进制保存在私有构建资产中，仓库只保存打包器和镜像装配方式。

在字体所属的 Windows 电脑运行：

```powershell
python -m pip install -r scripts/requirements-fonts.txt
python scripts/package-local-fonts.py --output ..\temp\private-fonts.tar.gz
```

默认扫描 Windows 系统字体目录和当前用户字体目录；`--root` 可重复指定。打包器按内容去重，记录字体族、嵌入标记、SHA-256 和不可读取项目。旧式 `.fon` 位图字体不属于 LibreOffice/fontconfig 的可用 OpenType 字体。

将归档解压到私有构建目录，用本目录的 Dockerfile 构建字体资产镜像，再在沙盒镜像构建时指定它：

```sh
docker build -f services/sandbox/fonts/Dockerfile --build-arg FONT_PACK_GENERATION=<manifest-generation> -t <private-font-image> <extracted-font-directory>
docker build -f services/sandbox/Dockerfile --build-arg WORKBENCH_FONT_IMAGE=<immutable-private-font-image> -t <sandbox-image> .
```

`WORKBENCH_FONT_IMAGE` 没有默认值，遗漏时构建失败。公共 CI 显式传入 `system-fonts`；生产必须指定已验证的私有字体镜像，并核对归档清单、`fc-list` 以及预览 PDF 的 `pdffonts` 结果。转换缓存以实际镜像 ID 区分字体和排版引擎版本。
