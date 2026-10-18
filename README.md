# dsh-mcp-manager

> 一个**轻量版 MCP 服务管理器**：管理本机已经接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 MCP 服务，
> 并能从 Claude Desktop / Cursor / VS Code 等客户端扫描、导入配置。
> 不做插件市场、不做远程目录、不做 OAuth 授权流——只把「本机 MCP」管好。

A lightweight MCP server manager for DeepSeek Harness (DSH): inspect, enable/disable, add, edit, remove,
probe, import from and export to the common `mcpServers` JSON convention. Zero npm dependencies.

## 它做什么

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 列出 MCP 服务 | `mcp_manager_list` / 设置页 | 来源（profile / 受管）、状态、传输、端点（脱敏）、工具数；支持关键词/状态过滤 |
| 查看详情与工具 | `mcp_manager_inspect` / 设置页展开 | 工具名 + 说明；状态区分「已连接 / 已停用 / 无工具 / 加载失败 / 未生效」 |
| 启用 / 停用 | `mcp_manager_set_enabled` / 开关 | 受管服务**持久化**；profile 静态行只改本次运行 |
| 接入新服务 | `mcp_manager_add` / 新增表单 | `streamable-http` 或 `stdio`；默认写入受管存储，重启自动恢复 |
| 编辑已有服务 | `mcp_manager_update` / 编辑表单 | URL / headers / command / args / env / cwd / 超时；密钥三态（保留/覆盖/删除） |
| 移除服务 | `mcp_manager_remove` / 删除按钮 | 受管：删记录+条目；profile：仅本次运行 |
| **握手探针** | `mcp_manager_probe` / 探针按钮 | 真实 initialize + tools/list：延迟、协议版本、工具数、结构化错误码、stderr（已脱敏） |
| **扫描本机配置** | `mcp_manager_scan` / 导入向导 | Claude Desktop / Claude Code / Cursor / Windsurf / VS Code / Cline / Zed / Continue |
| **导入 `mcpServers` JSON** | `mcp_manager_import` / 粘贴 JSON | 先预览（新增/冲突）再写；冲突支持跳过/覆盖受管/自动改名；可导入为停用 |
| **导出** | `mcp_manager_export` / 导出面板 | `patch`（cordis.patch.yml，`!!js process.env.*`）/ `json`（`mcpServers`，`${ENV}`）/ `markdown` 清单 |

## 持久化怎么工作

- **profile 静态声明**（`cordis.patch.yml` 里的 `@deepseek-ai/dsh-mcp-client` 行）保持只读：
  启停/编辑只影响本次运行，重启恢复；需要持久化就导出 patch。
- **本插件受管的连接**写入：
  `<DSH_HOME>/mcp-manager/connections-<profile>.json`（默认 `~/.dsh/mcp-manager/`）。
  启动时由插件自动 `ctx.loader.create/update` 成 `dsh-mcp-client` 条目，因此重启后仍在。
  - 文件权限 0600、目录 0700；原子写（tmp + rename）；每次覆盖前留一份 `.bak`；
  - 写操作串行化（同一进程内），JSON 损坏时**不覆盖原文件**、只在 UI/工具里报错。

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

装好后重启 DeepSeek Harness。Host 半区需要重启；Client 半区在有 `dsh-client-hmr` 的发行版里会热替换。

## 使用

- 设置 → **MCP 服务**：搜索/状态筛选，逐行启停、探针、编辑、删除；顶部「新增 / 导入 / 导出」；
- 对话里也可以直接说：「列出我的 MCP 服务」「探测 qcc-company 通的吗」「把 Cursor 里的 MCP 配置导入进来」
  「把当前配置导出成 patch」。

## 架构

```
┌──────────────────────── Harness 运行时 ────────────────────────┐
│  ctx.loader.entries() ──► mcp-client 条目（profile 行 + 受管行）      │
│  ctx.tools.schemas()  ──► mcp__<server>__* 工具，决定「已连接/工具数」 │
│  ctx.loader.update/create/remove ──► 启停 / 增删 / 编辑（运行时）    │
└────────────────────────────────────────────────────────────────┘
        ▲ 10 个对话工具 mcp_manager_*
        ▲ 同源 HTTP：/mcp-manager/api/state、/mcp-manager/api/action（回环 + 同源 fence）
        │
┌───────┴──────── Web UI（设置页 settings.section）──────────────┐
│ 列表 / 状态 chips / 搜索 / 探针 / 编辑 / 导入 / 导出 / 启停      │
└────────────────────────────────────────────────────────────────┘
```

代码结构（零 npm 依赖，只用 node 内建模块）：

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 插件入口 + manager 门面（list/add/update/remove/setEnabled/probe/scan/import/export） |
| `lib/store.js` | 受管连接存储（0600 / 原子写 / `.bak` / 串行 mutate） |
| `lib/config.js` | record 规范化、`mcpServers` JSON 互转 |
| `lib/inventory.js` | loader 条目 + 工具注册表 → 服务清单、状态判定 |
| `lib/provision.js` | 受管 record → `dsh-mcp-client` 条目（create/update/remove） |
| `lib/probe.js` | MCP 握手探针（streamable-http / stdio、错误分类） |
| `lib/importers.js` | 8 类客户端配置扫描、JSONC 解析、mcpServers 解析 |
| `lib/export.js` | patch / mcpServers JSON / Markdown 导出 |
| `lib/sanitize.js` | 统一脱敏出口（Bearer/JWT/URL/query/KEY=value/x-api-key…） |
| `lib/tools.js` / `lib/web.js` | 对话工具与同源 HTTP API |

### 状态语义

| 状态 | 判定 |
| --- | --- |
| 已连接 | 条目已启用、已有 fiber、命名空间下有工具 |
| 无工具 | 已启用且有 fiber，但工具数为 0（服务本身不提供，或连接失败被 mcp-client 吞掉） |
| 加载失败 | 已启用但没有 fiber（apply 抛错，常见于 serverName 重复声明） |
| 未生效 | 受管记录存在，但本次启动没有成功创建 loader 条目 |
| 已停用 | 条目 `disabled: true` |

同名重复（profile 行 + 受管记录共用一个 `serverName`）会在列表里打「同名」标记；
解析时拒绝猜测，要求传条目 id；导入时按冲突策略处理。

## 安全边界

- 凭据只进受管存储（0600）或由用户自己放在 `~/.dsh/.env` 里，导出/扫描/列表**不回显**值；
- 所有对外文本（探针 error/stderr、异常）统一过 `sanitize.js`；
- HTTP API 只接受本机回环 Host、校验 Origin 同源；
- 探针 stdio 子进程会清洗父进程环境中的凭据名（KEY/PASSWORD/SECRET/TOKEN、`DSH_*`）；
- 扫描只读其它客户端配置，不写回、不修改。

## 设计参考（GitHub 调研）

实现前调研了 DSH 生态 10 个 MCP 面板与 8 个通用 MCP 管理器，取其长：

| 借鉴点 | 来源项目 |
| --- | --- |
| 自管存储 + `loader.create/update` 运行时挂载（不碰用户配置文件） | hyqhyq3/dsh-mcp-manager、null119/dsh-mcp-manage、ArvinQi/dsh-mcp |
| 受管连接持久化、编辑/删除闭环 | 同上 + functy23/dsh-mcp-studio |
| 导入前 plan（新增/冲突）+ 冲突策略 | modelcontextprotocol/inspector（planImport） |
| `mcpServers` 多形态解析、JSONC、跨客户端互操作 | milisp/mcp-linker、ravitemer/mcphub.nvim |
| 探针结构化诊断（延迟/协议/错误码/stderr） | PerryLink/dsh-mcp-panel、milisp/mcp-linker |
| 密钥三态语义（缺省=保留 / null=删除 / 值=覆盖） | Fishquito7/dsh-skill-mcp-panel |
| 统一脱敏出口 | PerryLink/dsh-mcp-panel |
| 状态 chips、工具名搜索、诊断复制 | Js2Hou/dsh-mcp-manager、hyqhyq3/dsh-mcp-manager |

> 只借鉴设计思路，未复制代码；所有实现为本仓库独立编写。

## 开发与测试

```bash
node --check index.js && node --check client.js
node --test test/host.test.mjs    # 22 个：存储/清单/导入导出/探针/脱敏/schema
node --test test/client.test.mjs  # 7 个：模块注册、槽位、渲染、启停、探针、面板
npm test                          # 两套一起跑
```

端到端验证方式见 [`test/README.md`](test/README.md)。GitHub Actions 在 Node 20/22/24 上跑同一套测试。

## 卸载

```bash
./uninstall.sh                    # 桌面 profile
./uninstall.sh ~/.dsh/profiles/web
```

通过面板/CLI 安装的，直接在面板里停用/卸载。受管存储文件不会被自动删除（如需清理由你手动删）。

## 限制

- 状态里的「已连接」= 工具已注册，不代表服务端业务可用；探针才是真实握手（但不会调用业务工具）；
- 探针 tools/list 只取第一页（不翻 cursor），工具数特别多的服务可能少算；
- 不做 OAuth 授权流：需要 OAuth 的服务请自行获取 token 后用 `headers`/`env` 传入；
- 受管存储是明文 JSON（0600 权限），与 `~/.dsh/.env` 同级信任模型；不要把它提交进 git；
- 不做 profile 文件写入器：持久化统一走「导出 patch + 手动合并」，避免插件替用户改配置。

## License

[MIT](LICENSE)
