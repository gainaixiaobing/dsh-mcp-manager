# dsh-mcp-manager

> 一个**轻量版 MCP 服务管理器 + 调试台**：管理本机已经接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 MCP 服务，
> 能按应用归类（高德地图 / 同花顺 / 企查查…）、看服务健康、浏览并在线试用工具、收藏打标签，
> 也能从 Claude Desktop / Cursor / VS Code 等客户端扫描、导入配置。
> 不做插件市场、不做远程目录、不做 OAuth 授权流——只把「本机 MCP」管好。

A lightweight MCP server manager & debug console for DeepSeek Harness (DSH): inspect, enable/disable, add, edit,
remove, probe with history, browse and invoke MCP tools, import from and export to the common `mcpServers` JSON
convention. Zero npm dependencies.

## 它做什么

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 列出 MCP 服务 | `mcp_manager_list` / 设置页 | 来源（profile / 受管）、状态、传输、端点（脱敏）、工具数、所属应用；支持关键词/状态过滤 |
| **按应用归类** | `mcp_manager_apps` / 「按应用」视图 | 自动识别应用（高德地图/同花顺/企查查/北大法宝/知乎/小红书/飞书/GitHub…），多个服务聚合成一张卡；支持重命名、恢复自动识别、应用筛选 |
| 查看详情与工具 | `mcp_manager_inspect` / 设置页展开 | 工具名 + 说明；状态区分「已连接 / 已停用 / 无工具 / 加载失败 / 未生效」 |
| 启用 / 停用 | `mcp_manager_set_enabled` / 开关 | 受管服务**持久化**；profile 静态行只改本次运行 |
| 接入新服务 | `mcp_manager_add` / 新增表单 | `streamable-http` 或 `stdio`；默认写入受管存储，重启自动恢复 |
| 编辑已有服务 | `mcp_manager_update` / 编辑表单 | URL / headers / command / args / env / cwd / 超时；高级项 `reconnect` / `failOnStartupError` / `maxInstructionBytes`；密钥三态（保留/覆盖/删除） |
| 移除服务 | `mcp_manager_remove` / 删除按钮 | 受管：删记录+条目；profile：仅本次运行 |
| **握手探针 + 历史** | `mcp_manager_probe` / 探针按钮 | 真实 initialize + tools/list：延迟、协议版本、工具数、结构化错误码、stderr（已脱敏）；每次结果进历史（最近 20 次） |
| **批量探针** | `mcp_manager_probe_many` / 「全部探测」 | 默认探测所有已启用服务，并发可调；面板顶部显示健康概览与最近成功率 |
| **工具浏览** | `mcp_manager_tools` / 「工具中心」 | 跨服务搜工具；可按服务过滤、可选附带参数 JSON Schema |
| **在线试用工具** | `mcp_manager_call_tool` / 工具抽屉 | 走宿主 `ctx.tools.execute`（与模型同一执行管线，不绕过 guard/审批）；`dryRun` 预检、超时、结果截断标记 |
| **收藏 / 标签 / 备注** | `mcp_manager_prefs` / 星标 + 标签 | 按 `serverName` 持久化，profile 静态行也适用；面板按收藏优先排序 |
| **扫描本机配置** | `mcp_manager_scan` / 导入向导 | Claude Desktop / Claude Code / Cursor / Windsurf / VS Code / Cline / Zed / Continue |
| **导入 `mcpServers` JSON** | `mcp_manager_import` / 粘贴 JSON 或扫描结果 | 先预览（新增/冲突）再写；冲突支持跳过/覆盖受管/自动改名；可导入为停用；支持 JSONC |
| **导出** | `mcp_manager_export` / 导出面板 | `patch`（cordis.patch.yml）/ `json`（`mcpServers`）/ `markdown` 清单 / `diagnostics` 诊断报告 |
| **静态风险提示** | 服务对象 `riskFlags` | URL query 明文凭据、字面量 header/env 凭据、`--token` 参数、`$()`/反引号参数 |
| **存储修复** | `mcp_manager_store_repair` | 受管存储损坏时改名备份后重置，不用手动删文件 |

## 持久化怎么工作

- **profile 静态声明**（`cordis.patch.yml` 里的 `@deepseek-ai/dsh-mcp-client` 行）保持只读：
  启停/编辑只影响本次运行，重启恢复；需要持久化就导出 patch。
- **本插件受管的连接**写入：
  `<DSH_HOME>/mcp-manager/connections-<profile>.json`（默认 `~/.dsh/mcp-manager/`）。
  启动时由插件自动 `ctx.loader.create/update` 成 `dsh-mcp-client` 条目，因此重启后仍在。
- **面板偏好**（收藏/标签/备注/探针历史/自动探测开关）写入：
  `<DSH_HOME>/mcp-manager/prefs-<profile>.json`；同样按 profile 隔离。
- 两个文件都是：权限 0600、目录 0700；原子写（tmp + rename）；覆盖前留一份 `.bak`；
  写操作串行化；JSON 损坏时**不覆盖原文件**、只报错，并可用 `mcp_manager_store_repair` 恢复。
- `persist:false` 接入的条目只存在于本次运行，列表里带 `runtimeOnly` 标记，重启后不会恢复。

## 安装

### 方式一：DSH 面板

设置 → 插件 → 安装，spec 填：

```
github:gainaixiaobing/dsh-mcp-manager
```

### 方式二：CLI

```bash
dsh plugin --profile <profile> add github:gainaixiaobing/dsh-mcp-manager
```

### 方式三：从源码手动安装（离线）

```bash
git clone https://github.com/gainaixiaobing/dsh-mcp-manager.git
cd dsh-mcp-manager
./install.sh                 # 默认桌面 profile
./install.sh ~/.dsh/profiles/web
```

安装脚本会复制 `lib/`、`test/fixtures/`，并在安装后执行一次 `import()` 自检（失败自动回滚
`package.json`）。装好后重启 DeepSeek Harness。Host 半区需要重启；Client 半区在有 `dsh-client-hmr`
的发行版里会热替换（刷新页面即可）。

## 使用

- 设置 → **MCP 服务**：
  - 顶部健康概览（状态计数、最近探针成功率）、「全部探测」、自动探测开关；
  - 搜索 / 状态筛选；每行可收藏、打标签、看探针历史、启停、探针、编辑、删除；
  - 默认「按应用」视图：同花顺的 a-share/fund/meta、企查查的 company/risk/ipr… 各自聚成一张卡；
    组头可重命名/恢复自动识别，单服务应用收在「独立服务」区；也可切回「平铺」；
  - 「工具中心」跨服务搜工具，点开工具抽屉看 schema、填参数、试跑；
  - 「新增 / 导入 / 导出」（导出支持诊断报告与「仅受管 / 含 profile 行」两种 patch 范围）。
- 对话里也可以直接说：「列出我的 MCP 服务」「探测 qcc-company 通的吗」「qcc 有哪些查企业的工具」
  「用 dryRun 看下这个工具的 schema」「把 Cursor 里的 MCP 配置导入进来」「导出诊断报告」。

## 架构

```
┌──────────────────────── Harness 运行时 ────────────────────────┐
│  ctx.loader.entries() ──► mcp-client 条目（profile 行 + 受管行）      │
│  ctx.tools.schemas()  ──► mcp__<server>__* 工具，决定「已连接/工具数」 │
│  ctx.tools.execute()  ──► 工具「试用」走同一执行管线（guard/审批/超时）│
│  ctx.loader.update/create/remove ──► 启停 / 增删 / 编辑（运行时）    │
└────────────────────────────────────────────────────────────────┘
        ▲ 15 个对话工具 mcp_manager_*
        ▲ 同源 HTTP：/mcp-manager/api/state、/action（回环 + 同源 + 进程级 token）
        │
┌───────┴──────── Web UI（设置页 settings.section）──────────────┐
│ 健康概览 / 按应用分组 / 列表 / 工具中心 / 工具抽屉 / 探针历史     │
│ 编辑（含高级项）/ 导入向导 / 导出面板 / 启停 / 收藏标签          │
└────────────────────────────────────────────────────────────────┘
```

Host↔Client 的字段契约见 [`docs/v0.3-api.md`](docs/v0.3-api.md)。

代码结构（零 npm 依赖，只用 node 内建模块）：

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 插件入口 + manager 门面（list/add/update/remove/setEnabled/probe/probeMany/tools/invoke/prefs/scan/import/export/repairStore） |
| `lib/store.js` | 受管连接存储（0600 / 原子写 / `.bak` / 串行 mutate / 损坏修复） |
| `lib/prefs.js` | 面板偏好与探针历史（收藏/标签/备注/`ui.autoProbe`） |
| `lib/config.js` | record 规范化（含 reconnect 等高级项）、`mcpServers` JSON 互转 |
| `lib/inventory.js` | loader 条目 + 工具注册表 → 服务清单、状态判定、静态风险标记 |
| `lib/apps.js` | 应用目录与归类（serverName 前缀 / URL host / stdio 包名 / 手动覆盖）、按应用聚合 |
| `lib/provision.js` | 受管 record → `dsh-mcp-client` 条目（create/update/remove） |
| `lib/probe.js` | MCP 握手探针（streamable-http / stdio、错误分类、历史数据） |
| `lib/invoke.js` | 工具 schema 解析、示例参数、`ctx.tools.execute` 调用与结果折叠 |
| `lib/importers.js` | 8 类客户端配置扫描、JSONC 解析、mcpServers 解析 |
| `lib/export.js` | patch（managed-only / override）/ mcpServers JSON / Markdown / 诊断报告 |
| `lib/sanitize.js` | 统一脱敏出口（Bearer/Basic/JWT/URL/query/KEY=value/--token…） |
| `lib/tools.js` / `lib/web.js` | 对话工具与同源 HTTP API（token 鉴权） |

### 状态语义

| 状态 | 判定 |
| --- | --- |
| 已连接 | 条目已启用、已有 fiber、命名空间下有工具 |
| 无工具 | 已启用且有 fiber，但工具数为 0（服务本身不提供，或连接失败被 mcp-client 吞掉） |
| 加载失败 | 已启用但没有 fiber（apply 抛错，常见于 serverName 重复声明） |
| 未生效 | 受管记录存在，但本次启动没有成功创建 loader 条目 |
| 已停用 | 条目 `disabled: true` |

同名重复（profile 行 + 受管记录共用一个 `serverName`）会在列表里打「同名」标记，两条都会列出；
面板操作统一传 loader 条目 id，因此同名行也能启停/编辑/删除；导入时按冲突策略处理。

## 安全边界

- 凭据只进受管存储（0600）或由用户自己放在 `~/.dsh/.env` 里；列表/扫描回显的都是脱敏后的展示值；
- 导出默认脱敏：URL query 凭据、`--token` 类参数、值形状像凭据的 header/env 值会替换成 `${ENV}`
  占位符并写进 warnings；对话工具（`mcp_manager_export`）强制脱敏，设置页可显式关；
- 所有对外文本（探针 error/stderr、异常、解析错误）统一过 `sanitize.js`，且不回显 JSON 原文片段；
- HTTP API 需要**进程级随机 token**（host 注入页面 bootstrap，client 每次请求带
  `x-mcp-manager-token`），并只接受本机回环 Host、校验 Origin 同源；
- `import` 的 `file` 只接受本会话 `scan()` 发现过的客户端配置路径，不读任意文件；
- 探针 stdio 子进程会清洗父进程环境中的凭据名（KEY/PASSWORD/SECRET/TOKEN/PAT/AUTH/COOKIE/CREDENTIAL、
  `*_URL`/`*_URI`/`*_DSN`、`DSH_*`）；HTTP 探针失败不展示响应体；
- 扫描只读其它客户端配置，不写回、不修改。

## 设计参考（GitHub 调研）

v0.2 实现前调研了 DSH 生态 10 个 MCP 面板与 8 个通用 MCP 管理器；v0.3 又做了一轮增量调研
（12 个 2026 年仍活跃的项目，见 `research/v0.3-github-survey.md`）：

| 借鉴点 | 来源项目 |
| --- | --- |
| 自管存储 + `loader.create/update` 运行时挂载（不碰用户配置文件） | hyqhyq3/dsh-mcp-manager、null119/dsh-mcp-manage、ArvinQi/dsh-mcp |
| 导入前 plan（新增/冲突）+ 冲突策略 | modelcontextprotocol/inspector（planImport） |
| 工具 schema 展示与在线执行（SchemaForm + Execute） | modelcontextprotocol/inspector |
| 探针结构化诊断（延迟/协议/错误码/stderr） | PerryLink/dsh-mcp-panel、milisp/mcp-linker |
| 密钥三态语义（缺省=保留 / null=删除 / 值=覆盖） | Fishquito7/dsh-skill-mcp-panel |
| 统一脱敏出口 | PerryLink/dsh-mcp-panel |
| 静态风险审计（args 里的 `$()`/反引号、明文凭据） | RealZST/HarnessKit（MCP auditor 规则） |
| 导入 dry-run 预览 + 应用前快照 + 失败回滚（部分借鉴） | xiajiajun516/dsh-config-manager |
| 状态 chips、工具名搜索、诊断复制 | Js2Hou/dsh-mcp-manager、hyqhyq3/dsh-mcp-manager |
| 按「应用/profile」组织服务、跨客户端归类视图 | mcpm.sh（virtual profiles）、RealZST/HarnessKit（跨 agent 归类矩阵） |

> 只借鉴设计思路，未复制代码；所有实现为本仓库独立编写。

### 后续（v0.5 候选，未实现）

- 客户端接入片段生成器（一键生成 Claude Code / Cursor / VS Code / DSH 片段）；
- 服务套件（Kit）内置 starter kit + 空态引导；
- 官方 MCP Registry `server.json` 导入；
- 导入向导 v3：明文凭据剥离、逐条冲突、应用前快照与失败回滚；
- OAuth / 远程注册表 / 网关形态暂不做——那属于连接器而不是本机管理器。

## 开发与测试

```bash
node --check index.js && node --check client.js
node --test test/host.test.mjs    # Host：存储/清单/导入导出/探针/工具/偏好/安全/契约
node --test test/web.test.mjs     # 同源 API：token 鉴权、回环/Origin/IPv6、白名单、state 体积
node --test test/client.test.mjs  # Web UI：模块注册、槽位、列表、工具抽屉、探针、导出
npm test                          # 三套一起跑
```

端到端验证方式见 [`test/README.md`](test/README.md)。GitHub Actions 在 Node 20/22/24 上跑同一套测试。

## 卸载

```bash
./uninstall.sh                    # 桌面 profile
./uninstall.sh ~/.dsh/profiles/web
```

通过面板/CLI 安装的，直接在面板里停用/卸载。受管存储与偏好文件不会被自动删除（如需清理由你手动删）。

## 限制

- 状态里的「已连接」= 工具已注册，不代表服务端业务可用；探针才是真实握手（但不会调用业务工具）；
- 「试用」会真实调用工具，可能产生副作用（写数据、发请求）；不确定时先 `dryRun`；
- 探针 tools/list 只取第一页（不翻 cursor），工具数特别多的服务可能少算；
- 不做 OAuth 授权流：需要 OAuth 的服务请自行获取 token 后用 `headers`/`env` 传入；
- 受管存储是明文 JSON（0600 权限），与 `~/.dsh/.env` 同级信任模型；不要把它提交进 git；
- 不做 profile 文件写入器：持久化统一走「导出 patch + 手动合并」，避免插件替用户改配置；
- 应用归类是启发式（内置目录 + URL/前缀推断），识别不准时可在面板里重命名，覆盖会持久化到偏好文件；
- 不按工具启停/描述覆写：底层 `dsh-mcp-client` 没有工具过滤字段，本插件不伪造这层能力。

## License

[MIT](LICENSE)
