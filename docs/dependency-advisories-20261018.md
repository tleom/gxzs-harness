# 生产 npm 依赖复核（2026-10-18）

本次以提交 `18f89dc` 加本轮未提交修复为边界，使用各生产锁文件执行 `npm audit --omit=dev --json`。结果描述 npm 公告命中，不覆盖 OS/Python，也不证明任意依赖永远安全。

| 锁树 | Critical | High | Moderate | Low |
| --- | ---: | ---: | ---: | ---: |
| profiles/workbench | 0 | 0 | 0 | 0 |
| services/sandbox/office | 0 | 4 | 3 | 0 |
| services/sandbox/office/mermaid | 0 | 0 | 0 | 0 |
| services/browser-client | 0 | 0 | 0 | 0 |

Office 的 7 个节点来自 2 条公告及其父依赖，不是 7 个独立漏洞。F13 状态为 `accepted-known-risk`：已升级可修复依赖，用户明确选择保留现有功能、将两份上游公告列为已知风险；当前产品调用边界不新增补丁。没有关闭告警、忽略版本或将 npm 扫描改为假成功；执行错误会阻断 CI，漏洞发现保留在日志和摘要中。

## 已修订的依赖

profile / MCP tools 的 Ajv 固定到 8.20.0；profile 的 fflate 固定到 0.8.3。Office 的 sharp 固定到 0.35.5、image-size 到 2.0.3、brace-expansion 的 1.x / 2.x 到 1.1.21 / 2.1.7、source-map-js 到 1.2.2、uuid 到 11.1.1。Mermaid 的 DOMPurify / KaTeX 固定到 3.4.16 / 0.18.7。

同步维护 npm / pnpm 锁文件，并以实际安装与 SVG→PNG、图片尺寸、PPTX 图片、Excel 条件格式 UUID 和 XLSX 写入、浏览器与 Mermaid 冒烟校验兼容性。uuid 的当前 ExcelJS 调用只使用无参 `v4()`，不是靠大版本覆盖后假定兼容。

## 剩余调用路径

### braces：没有确认的产品输入路径

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 涉及深层 brace pattern 的递归栈耗尽；本次核对时官方 patched versions 为 None。

实际依赖为 `@tailwindcss/cli 4.3.3 → @parcel/watcher 2.5.1 → micromatch 4.0.8 → braces 3.0.3`。安装后的 `@parcel/watcher/wrapper.js` 在 `normalizeOptions()` 中仅当 `opts.ignore` 是数组才把其中的 glob 交给 `micromatch.makeRe()`。该版本 `micromatch/index.js` 的 `makeRe` 直接转调 `picomatch.makeRe`，并不进入 braces；调用 braces 的是另外的 `parse`、`braces`、`braceExpand` 接口。因此依赖父节点命中不等于 watcher 已触发此漏洞。

当前 Tailwind `dist/index.mjs` 的 watcher `subscribe()` 调用还只有目录和事件回调，没有第三个 options 参数。用户 CSS、文件名和文件内容没有被该调用方送入 ignore 编译路径，更没有确认到 braces 的路径。普通非 watch 构建也不调用 watcher 的 ignore 编译路径。

### sprintf-js：格式来自固定 CLI 定义

[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) 要求控制格式串中的数值精度；本次核对时官方 patched versions 为 None。

实际依赖为 `mammoth 1.12.3 → argparse 1.0.10 → sprintf-js 1.0.3`。安装后的 `mammoth/bin/mammoth` 用固定字符串声明 usage/help/choices；`argparse/lib/help/formatter.js` 的格式来自这些定义，`argument_parser.js` 的错误格式同样是常量。DOCX 正文、输入路径、输出路径和参数值没有被当成格式串。平台文档预览也没有调用这个 CLI 参数解析路径。

## 风险边界与后续处置

现有产品调用方中未确认不可信文档到两个危险参数的路径，因此没有为降低扫描数字而退回 npm 建议的旧 Tailwind 4.3.0 或 Mammoth 0.3.29，也没有删除用户现有的文档与网页制作能力。上述结论依据当前锁定版本源码；调用方更新后需重查，不能作为永久豁免。

独立受限探针进一步验证：直接调用漏洞原语仍能触发栈/精度异常；watcher 四个 wrapper 入口处理普通 glob 与深层 ignore 时均未进入 braces；真实 Mammoth CLI 的路径、选项值和 DOCX 精度字符串正文均未变为 sprintf 格式串。探针运行于 Windows / Node 22，Linux 镜像的普通 Office 能力另有冒烟证据，不能将这些结果解释为包级漏洞已经修复。

有 shell 执行权的 Agent 可直接 `require()` 任意预装包，也可自行运行耗尽资源的代码。这属于 owner Sandbox 内已有执行能力；容器资源上限和进程取消负责限制影响，不能由“当前平台入口未可达”推导为整个包已修复。不要把这两个包引入 Host/Manager 常驻请求处理进程，或新增接受外部 ignore pattern / format string 的接口。

最小后续修复是官方补丁发布后升级锁文件，并重跑当前 Office 能力冒烟；若业务未来必须把上述危险参数暴露给外部输入，应在该入口限制 pattern 深度、格式精度并用可终止的独立进程处理。在当前不存在的入口上增加包装层不会约束任意用户脚本，故本次没有添加这样的冗余封装。
