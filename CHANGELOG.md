# Changelog

## [0.4.2] — 2026-11-03

### Fixed

- **设置左侧导航显示 `nav.label`（以及面板内大量 `xxx.yyy` 原始 key）**：DSH 的 locale 服务是
  扁平 key 查表（`t('a.b')` 直接取 `dict['a.b']`），不会按 `.` 遍历嵌套对象；本插件此前注册的是
  嵌套字典，所以只有根级 key（如 `title`）能命中。现在注册前把 zh/en 字典压平，
  导航显示「MCP 服务」，面板内 `status.* / column.* / form.* / importer.* / exporter.* /
  health.* / apps.* / drawer.*` 等文本全部正常。
- client 测试的 locale mock 改为与真实服务一致的扁平查表，并加回归断言（字典值必须全为字符串、
  `nav.label` 必须命中），以后不会再漏。

## [0.4.1] — 2026-11-03

### Fixed

- 内置应用目录新增「📕 小红书」（`xiaohongshu` / `xhs` / `redbook`、`xiaohongshu.com`）：
  此前受管接入的 `xiaohongshu` 服务会直接显示成 serverName，而不是应用名。
- 测试隔离：host 测试把 `DSH_HOME` 指向临时目录，不再写用户真实偏好文件
  （v0.4.0 测试期间曾把 `rt` / `conv-srv` 写进 `~/.dsh/mcp-manager/prefs-<profile>.json`；
  本机已清理，用户收藏/标签/备注不受影响）。

## [0.4.0] — 2026-11-03

按「应用」归类：多个 MCP 服务聚合成一张卡（高德地图 / 同花顺 / 企查查 / 北大法宝…），
面板默认用「按应用」视图，告别一长串 serverName。

### Added

- **应用目录与自动归类**（`lib/apps.js`）：内置常见应用（高德地图、同花顺、企查查、北大法宝、
  知乎、飞书、GitHub、DeepSeek、文件系统、fetch、memory、Playwright、SQLite），
  按 serverName / 前缀 / URL host / stdio 包名匹配；未知服务再按域名、公共前缀、独立服务兜底。
- **`mcp_manager_apps` 对话工具**：按应用列出服务数、健康计数、工具数；支持按应用名过滤。
- **`state.apps` + `server.app`**：host 侧聚合并排好序，UI 直接渲染；每个服务带
  `app: {id,name,icon,vendor,source}`。
- **`renameApp` action / 组内批量覆盖**：重命名一个应用组会写入该组全部服务的 `prefs.app`；
  传 `name=null` 清除覆盖、恢复自动识别。
- **`patchPrefs` 支持 `app`**：单个服务也能手动归类。
- **面板「按应用」视图**（默认）：「平铺」可切回；多服务应用显示为可折叠组卡（icon + 名称 +
  服务数 + 健康小计 + 工具数），单服务应用收进「独立服务」区；组头支持重命名/恢复；
  应用筛选 chips 与状态筛选、搜索叠加。
- **导出/列表带应用**：Markdown 清单新增「应用」列；`mcp_manager_list` 渲染里附带按应用摘要。

### Changed

- 版本 0.4.0；Host↔Client 契约补充第 8 节（应用归类）。

### Tests

- host 新增：应用识别（catalog/host/prefix/self/手动覆盖）、state 聚合、应用重命名/重置、
  `mcp_manager_apps` 工具；client 新增：分组渲染、折叠、应用筛选、重命名、独立服务区、编辑面板归类。
- 全量：**66 个用例**（host 39 + web 4 + client 23），`npm test` 全绿。

## [0.3.0] — 2026-11-03

从「配置管理器」升级为「MCP 调试台 + 健康看板」：工具可浏览、可在线试用；
探针有历史、能批量跑；服务能收藏/打标签；同时修掉了一轮外部审计发现的
2 个 P0 与 9 个 P1（安装脚本、导出、脱敏、HTTP 鉴权、UI 同名操作等）。

### Added

- **工具浏览与在线试用**：
  - `mcp_manager_tools` 跨服务搜索工具（可按服务过滤，可选附带参数 JSON Schema）；
  - `mcp_manager_call_tool` 真实调用一个 MCP 工具（走宿主 `ctx.tools.execute` 同一执行管线，
    不绕过 guard/审批），支持 `dryRun` 预检、超时（1–120s）、参数/结果体积上限与截断标记；
  - 设置页新增「工具中心」与工具抽屉：schema 查看、示例参数、JSON 参数编辑、执行与结果展示。
- **探针历史与健康看板**：
  - 探针结果写入偏好存储（每服务最近 20 次：时间/成功/延迟/工具数/错误码）；
  - `mcp_manager_probe_many` 批量探测（默认全部已启用服务，并发 1–8）；
  - 设置页顶部健康条：状态计数、最近探针成功率、「全部探测」、自动探测开关（`ui.autoProbe`）。
- **收藏 / 标签 / 备注**：`mcp_manager_prefs` + 面板星标与标签，按 `serverName` 持久化
  （profile 静态行也适用），存放在 `prefs-<profile>.json`（0600、原子写、`.bak`、串行写）。
- **高级配置**：编辑表单可改 `reconnect`（enabled/initialDelayMs/maxDelayMs/maxAttempts）、
  `failOnStartupError`、`maxInstructionBytes`；`reconnect` 支持浅合并。
- **诊断报告**：`mcp_manager_export format=diagnostics` / 面板导出「诊断报告」：
  状态汇总 + 问题清单（失败/无工具/未生效/同名/最近探针失败）+ 探针历史，不含凭据。
- **静态凭据风险提示**：服务对象新增 `riskFlags`（`url-secret` / `header-secret` / `env-secret` /
  `args-secret` / `shell-args`），只看配置、不发请求。
- **多服务导出**：`export` 支持 `servers: string[]` 只导出选中服务。
- **存储修复**：`mcp_manager_store_repair` + `POST action=repairStore`：损坏的受管存储可改名备份
  （`.corrupt-<时间戳>`）后重置，不用手动删文件。
- **UI**：编辑面板高级项、导入面板支持从扫描到的文件路径导入、导出面板支持 diagnostics /
  patch 范围（仅受管 / 含 profile 行）、探针失败诊断复制、同名条目改用条目 id 操作。

### Changed

- **patch 导出的持久化语义修正（P0）**：默认**只导受管记录**——profile 静态行已经在
  `cordis.patch.yml` 里，再 `- insert:` 会重复 loader id 导致下次启动 fail-loud；
  需要时传 `includeProfile=true`，profile 行会以「按 id 覆盖」的片段导出并给出提示。
- `export` 工具在对话里**强制脱敏**（避免明文凭据进入模型上下文）；设置页 web API 仍可显式
  `redact:false`。
- 新上线的 HTTP API 需要 `x-mcp-manager-token`（进程级随机 token，由 host 注入页面 bootstrap）：
  挡住「本机任意进程直接 curl 改配置」；token 只经 index 注入，不下发凭据。
- `mcp_manager_import` 的 `file` 只接受**本会话 `scan()` 发现过的配置文件路径**，不再读任意路径。
- `GET /state` 不再返回每个服务的工具说明大字段（实测从 ~186KB 降到只含 `toolNames`），
  需要的工具 schema 走 `tools` / `toolDetail` 按需取。
- 受管/运行时条目区分：`persist:false` 接入的条目带 `runtimeOnly: true`，按「仅本次运行」处理；
  profile 与受管记录同名时两条都会列出并标 `duplicate`（此前 profile 行会被误标成受管）。
- 探针返回统一补 `serverNameRemote`、`history`；`state.toolCount` 改用 summary（此前恒为 0）。

### Fixed

- **安装脚本（P0）**：`install.sh` 现在会复制 `lib/` 与 `test/fixtures/`，安装后执行
  `import('index.js')` 自检，失败自动回滚 `package.json`（此前方式三安装完直接 `ERR_MODULE_NOT_FOUND`）。
- **stdio 探针定时器泄漏**：每次 RPC 成功/结束都会清理定时器并 reject 挂起请求；
  整套测试从 ~10.2s 降到 ~5s，探针进程不再拖 10s 才退出。
- **脱敏补洞（P1）**：
  - 导出会对 URL query 凭据、stdio `--token` 类参数、以及「值形状像凭据」的 header/env 值生成
    `${ENV}` 占位符并写进 warnings；
  - `sanitize.js` 覆盖 `Basic`/`Digest`/`ApiKey`/整段 `Authorization`、`--token` 参数、
    `*PAT/*COOKIE/*AUTH` 变量名；
  - `config` 编辑视图里的 URL 凭据会被掩码（`urlMasked`），提交空 URL 表示保持原值；
  - import 预览的 endpoint 统一走 `endpointOf()`（不再回显 URL query 原文）；
  - 解析 JSON 的错误只给「第 N 字节/行附近」，不回显原文片段。
- **YAML 导出合法性**：key 一律做引号/保留字处理、多行值用 `|-` 块标量、数字样字符串加引号
  （此前 `X: INJECTED`、PEM 多行值、`@reserved` 会产出非法或被静默改值的 YAML）。
- **浏览器/本机请求边界**：IPv6 回环 `[::1]` 不再误判 403；`Sec-Fetch-Site`/Origin 同源校验保留。
- **JSONC 导入**：粘贴路径也支持注释与尾逗号；尾逗号改由状态机处理，
  不再误伤字符串里的 `",}"`（此前会静默改 URL/args）。
- **存储元数据**：`createdAt` / `updatedAt` 不再在重启后丢失。
- **remove 语义**：受管记录被删除即 `removed: true`（另给 `entryRemoved` 表示条目是否本来存在），
  不再出现「提示没删掉、实际已删除」。
- **stdio 探针环境清洗**：除 `KEY/PASSWORD/SECRET/TOKEN` 外，补充 `PAT/AUTH/COOKIE/CREDENTIAL`
  与 `*_URL / *_URI / *_DSN`（连接串常带密码）；HTTP 探针失败不再回显响应体（降低受限 SSRF 信息面）。
- 存储临时文件名改用 `basename()`，兼容 Windows 路径。

### Tests

- 新增 `test/web.test.mjs`（token 鉴权、回环/Origin/IPv6、action 白名单、state 体积）；
- host 测试新增：偏好存储、工具目录/试用、高级配置、探针历史/诊断、批量探针、多服务导出、
  patch 默认范围、URL 掩码、导入文件白名单、导出脱敏、YAML 合法性、state 字段、remove 语义、
  存储修复；`npm test` 覆盖 host + web + client 三套。

## [0.2.0] — 2026-10-18

参考 GitHub 上 10 个同类项目（DSH 生态 MCP 面板 + 通用 MCP 管理器）重做的一版：
从「只读清单 + 运行时启停」升级为「可持久化、可导入导出、可探针诊断」的完整管理器。

### Added

- **自管连接存储**：`<DSH_HOME>/mcp-manager/connections-<profile>.json`（0600、原子写、写前 `.bak`、串行 mutate）。
  接入/编辑/启停/删除可跨重启保留；与 profile 静态声明互不覆盖。
- **`mcpServers` JSON 导入**：支持 `{mcpServers}` / `{servers}` / `{context_servers}` / 裸映射 / 数组；
  支持 JSONC（注释、尾逗号）；先 `plan`（新增/冲突）再写，冲突可 `skip` / `overwrite`（仅受管）/ `rename`（-2/-3…）。
- **`mcpServers` JSON 导出**：凭据脱敏为 `${ENV}` 占位符；另支持 patch（`!!js process.env.*`）与 Markdown 清单。
- **本机客户端配置扫描**：Claude Desktop / Claude Code / Cursor / Windsurf / VS Code / Cline / Zed / Continue；
  只返回元信息（客户端/文件/服务名/传输/端点/是否含凭据/是否冲突），不回显 env/headers 值。
- **MCP 握手探针**（`mcp_manager_probe` + UI「探针」）：initialize + notifications/initialized + tools/list，
  支持 streamable-http 与 stdio；返回延迟、协议版本、服务端信息、工具数、结构化错误码
  （`timeout` / `connection_refused` / `dns_error` / `command_not_found` / `process_exit` / `http_4xx` / …）
  与脱敏后的 stderr、退出码；同服务并发请求合并、全局并发 ≤4。
- **编辑已有服务**（`mcp_manager_update` + UI 编辑表单）：URL / headers / command / args / env / cwd / 超时；
  密钥三态语义：缺省=保留、`null`/`deleteHeaders`/`deleteEnv`=删除、新值=覆盖。
- **UI v2**：搜索（含工具名）、状态筛选 chips、来源徽标、探针结果与诊断复制、导入向导（扫描/粘贴/冲突策略）、
  导出面板（patch / JSON / Markdown + 下载/复制）、新增/编辑/删除。
- **统一脱敏出口**：Bearer/JWT/URL userinfo/query 凭据/`KEY=value`/`x-api-key` 等，覆盖探针错误、stderr、异常文本。

### Changed

- 实现拆分为 `lib/{index,store,config,inventory,provision,probe,importers,export,tools,web,util,sanitize}.js`；
  `index.js` 仅做 re-export（保持包入口兼容）。
- 启停等待从「工具数 > 0」改为等待 loader fiber 状态，避免把合法 0 工具服务误判为未连上。
- 受管服务停用后仍创建 `disabled` 条目，列表可见、可一键恢复。

### Security

- 存储文件 0600、目录 0700；导出默认脱敏；扫描不回显凭据值；HTTP API 仅回环 + 同源。
- 探针 stdio 子进程环境做凭据名清洗（KEY/PASSWORD/SECRET/TOKEN 与 `DSH_*`）。

## [0.1.0] — 2026-10-18

首个版本：清单、启停、运行时增删、导出 patch、设置页列表。
