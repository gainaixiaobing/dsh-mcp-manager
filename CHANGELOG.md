# Changelog

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
