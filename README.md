# dsh-mcp-manager

> 一个**轻量版 MCP 服务管理器**：管理本机已经接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 MCP 服务。
> 对照 `dsh-mcp-connector`（插件市场 + 远程目录 + OAuth 授权 + 安装分发）重新实现的最小版本——
> 不做"连接器市场"，只管理**已有的** MCP 服务。

A lightweight MCP server manager for DeepSeek Harness (DSH): inspect, enable/disable, add, remove,
and export the MCP servers already configured in a DSH profile. No marketplace, no OAuth
authorization flow, no remote catalog — just the local inventory.

## 它做什么

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 列出全部 MCP 服务 | `mcp_manager_list` / 设置页 | 服务名、来源（profile 声明 / 插件动态接入）、传输方式、端点（已脱敏）、状态、当前可用工具数 |
| 查看单个服务与工具 | `mcp_manager_inspect` / 设置页展开 | 工具名 + 说明；状态区分「已连接 / 已停用 / 无工具 / 加载失败」 |
| 启用 / 停用 | `mcp_manager_set_enabled` / 设置页开关 | 走 `ctx.loader.update`，立即断开/重建连接并增删 `mcp__<server>__*` 工具 |
| 运行时接入新服务 | `mcp_manager_add` | `streamable-http` / `stdio`；同名服务则更新配置 |
| 运行时移除服务 | `mcp_manager_remove` | 只是移除运行时条目，不改 profile 文件 |
| 导出为持久化配置 | `mcp_manager_export` | 生成可并入 `cordis.patch.yml` 的 YAML；凭据自动脱敏成 `!!js process.env.*` |
| 图形界面 | DSH 设置页 →「MCP 服务」 | 列表 / 状态 / 工具数 / 工具展开 / 启停开关 / 刷新 |

## 为什么再写一个

| | `dsh-mcp-connector` | `dsh-mcp-manager` |
| --- | --- | --- |
| 定位 | 连接器市场（发现、安装、OAuth 授权、分发） | 本机已接入服务的日常管理 |
| 数据来源 | 自带连接记录表 + 远程 catalog | 直接读 Harness 运行时（loader 条目 + 工具注册表） |
| 新增服务 | 目录挑选 / OAuth / 导入 JSON | 直接给 `serverName + transport + url/command` |
| 存储 | 自己的 storage 表（连接、grant、快照、治理） | 不落盘；运行时生效，持久化交给 `mcp_manager_export` |
| 工具数量 | 约 20 个 `mcp_connector_*` | 6 个 `mcp_manager_*` |
| 外部依赖 | catalog URL、OAuth、HTTP 探活 | 无网络依赖，零 npm 依赖 |

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

# 默认装到桌面 profile；也可传入其它 profile 目录（如 ~/.dsh/profiles/web）
./install.sh
./install.sh ~/.dsh/profiles/web
```

`install.sh` 只做两件事（幂等，会先备份 `package.json`）：

1. 复制本目录到 `<profile>/node_modules/dsh-mcp-manager`；
2. 在 `<profile>/package.json` 的 `dsh.profile.bundles` 末尾登记 `dsh-mcp-manager`。

**不修改** profile 的 `cordis.patch.yml`、不改依赖版本、不跑 pnpm：插件行由 bundle 自带的
`cordis.patch.yml` 在合成 profile 时插入。

装好后重启 DeepSeek Harness。Host 半区需要重启；Client 半区在有 `dsh-client-hmr` 的发行版里会热替换。

## 使用

- 设置 → **MCP 服务**：每行一个服务，右侧开关启停，点「查看工具」展开工具；
- 或直接在对话里说：「列出我的 MCP 服务」「停用 fuyao-fund」「把 github 重新启用」「导出当前 MCP 配置」。

> 启停、增删、改配置都是**运行时**生效：重启 Harness 后恢复 `cordis.patch.yml` 里的声明。
> 这是刻意设计——管理插件不应该偷偷改写你的 profile。需要持久化时调用 `mcp_manager_export`，
> 把输出的 YAML 片段粘贴进 profile 的 `cordis.patch.yml`。

## 架构

```
┌──────────────────────── Harness 运行时 ────────────────────────┐
│  ctx.loader.entries() ──► 找出 name === '@deepseek-ai/dsh-mcp-client' 的条目
│        │                     （profile 静态行 + 其他插件动态 provision 的行）
│        ├─ fiber.config ──► serverName / transport / url / command（凭据不回显）
│        └─ entry.disabled ─► 启停状态
│  ctx.tools.schemas() ────► 按 mcp__<serverName>__ 前缀统计工具数/工具名
│        │
│  ctx.loader.update/create/remove ──► 启停 / 增删（运行时）
└────────────────────────────────────────────────────────────────┘
        ▲ 对话工具（6 个 mcp_manager_*）
        ▲ 同源 HTTP：GET /mcp-manager/api/state、POST /mcp-manager/api/action
                     ▲ 回环 + Origin/Host 同源 fence；无凭据返回
        │
┌───────┴──────── Web UI（设置页 settings.section）──────────────┐
│  列表 / 状态 / 工具数 / 工具展开 / 启停开关 / 刷新              │
└────────────────────────────────────────────────────────────────┘
```

设计要点：

- **零依赖**：`index.js` 不 import 任何包（连 `@deepseek-ai/dsh-tools` 也不 import），
  `client.js` 只 `require('react')`，避免第三方插件在 profile 里的模块解析风险；
- **不落盘**：没有自己的 storage，不复制凭据，不写 profile 文件；
- **不猜主体**：服务名解析支持精确名 / 条目 id / 唯一子串，多候选时直接报错让人选；
- **脱敏**：端点去掉 query/hash；stdio 只显示可执行文件名；导出时 headers/env 里的
  `Authorization / token / key / secret / password / cookie ...` 一律替换成
  `!!js process.env.<占位符>`。

## 插件配置（`cordis.patch.yml` 里的 `config`）

```yaml
- insert:
    - id: mcp-manager
      name: 'dsh-mcp-manager'
      config:
        webApi: true               # 是否挂载 /mcp-manager/api（设置页需要；默认 true）
        includeDescriptions: true  # 工具清单里是否带工具说明（默认 true）
```

## 状态判定与两个常见坑

| 状态 | 判定 | 含义 |
| --- | --- | --- |
| 已连接 | 条目已启用且存在 fiber，命名空间下有工具 | 正常 |
| 已停用 | `entry.disabled === true` | 被人为停用 |
| 无工具 | 条目已启用且有 fiber，但命名空间下 0 个工具 | 服务本身不提供工具，或工具名冲突被拒 |
| 加载失败 | 条目已启用但**没有 fiber** | apply 抛错，最常见原因是 serverName 与另一条目重复 |

**同名重复**：profile 静态声明的行（条目 id 形如 `include:mcp-xxx`）和其他插件动态
provision 的行（形如 `mcp-xxx-xxx`）可能声明同一个 `serverName`。`dsh-mcp-client` 会拒绝
重复命名空间，**后加载的条目会「加载失败」**，但两者共用 `mcp__<server>__` 工具命名空间，
所以工具只统计一份。列表里会给这类服务打「同名」标记；`mcp_manager_set_enabled` /
`inspect` 遇到同名会拒绝猜测，要求传**条目 id**（如 `include:mcp-amap` 或
`mcp-amap-amap`）。导出时会按 serverName 去重并提示。

## 开发与测试

```bash
node --check index.js && node --check client.js
node --test test/host.test.mjs    # Host 半区：枚举/解析/启停/增删/导出 + schema 子集校验
node --test test/client.test.mjs  # Client 半区：模块注册、槽位注册、三种状态的渲染与开关交互
```

离线测试用假 `ctx`（loader / tools）和最小 React 渲染器，不需要启动 Harness。
端到端验证方式见 [`test/README.md`](test/README.md)。

## 卸载

```bash
./uninstall.sh                    # 桌面 profile
./uninstall.sh ~/.dsh/profiles/web
```

会从 bundles 列表移除 `dsh-mcp-manager` 并删除 `<profile>/node_modules/dsh-mcp-manager`，随后重启应用。
通过面板或 CLI 安装的，直接在面板里停用/卸载即可。

## 限制

- 状态里的「已连接」只代表工具已注册，不代表服务端一定能应答（Harness 没向插件暴露连接诊断）；
- 加载失败的条目能看到，但插件拿不到失败原因（错误只进日志）；
- 不做 OAuth：需要 OAuth 的服务请用 `dsh-mcp-connector`，或自己拿到 token 后用
  `mcp_manager_add` 的 `headers` 传 `Authorization`；
- 启停/增删不持久化（见上文），持久化用 `mcp_manager_export`；
- 设置页导航图标由宿主固定映射，第三方插件显示为齿轮图标。

## License

[MIT](LICENSE)
