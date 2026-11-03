# 测试与端到端验证

三个测试套件全部离线（不启动 Harness，不发外部网络请求）：

```bash
node --test test/host.test.mjs    # Host 半区：存储/清单/导入导出/探针/工具/偏好/安全/契约
node --test test/web.test.mjs     # 同源 HTTP API：token 鉴权、回环/Origin/IPv6、白名单、state
node --test test/client.test.mjs  # Web UI：模块注册、槽位、列表、工具抽屉、探针、导出
npm test                          # 三套一起跑
```

Host 测试里只有「探针」相关用例会真起 `test/fixtures/stub-mcp.mjs`（本地 stdio，无网络）；
`web.test.mjs` 用假的 webServer/request/response；`client.test.mjs` 用 `new Function` 跑
client factory 并 mock `window.__ModuleLoader__`。

## 在真实 Harness 里验证（可选）

离线测试覆盖了纯逻辑与前端渲染；如需在真实 Harness 里验证，可用一个**临时 profile**，
不要动正在使用的桌面 profile：

```bash
# 1) 建一个临时 profile（从 shipped headless 模板复制）
T=~/.dsh/profiles/mcphead-test
cp -R ~/.dsh/profiles/headless "$T" && mkdir -p "$T/node_modules"
cp -R <插件目录> "$T/node_modules/dsh-mcp-manager"

# 2) 在 $T/package.json 的 dsh.profile.bundles 里追加 "dsh-mcp-manager"，
#    并在 $T/cordis.patch.yml 里插入一个 @deepseek-ai/dsh-mcp-client 条目（stdio 指向任意本地 MCP 服务器）

# 3) 合成检查 + 真跑
dsh --profile mcphead-test --dump-config | grep -A4 mcp-manager
dsh --profile mcphead-test "用 mcp_manager_list 列出 MCP 服务，并停用其中一个"
```

Web 半区验证：同样方式建临时 profile（bundles 用 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`
+ 插件），`dsh --profile <tmp> --no-open --port 0` 启动后：

```bash
# v0.3 起 HTTP API 需要进程级 token：先从未登录页 HTML 里取
#   window.__MCP_MANAGER_TOKEN__="<hex>"
PORT=<port>
TOKEN=$(curl -s "http://127.0.0.1:$PORT/" | grep -o '__MCP_MANAGER_TOKEN__="[a-f0-9]*"' | cut -d'"' -f2)

curl -s -H "x-mcp-manager-token: $TOKEN" "http://127.0.0.1:$PORT/mcp-manager/api/state" | jq .
curl -s -H "x-mcp-manager-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"method":"setEnabled","params":{"server":"<entry-id>","enabled":false}}' \
  "http://127.0.0.1:$PORT/mcp-manager/api/action"
```

> 不含 token 或 token 错误会返回 401；跨站 Origin / 非回环 Host 返回 403。
> 面板操作统一传 loader 条目 id（`GET /state` 的 `servers[].id`），同名服务也能精确操作。

验证完删除临时 profile（`rm -rf ~/.dsh/profiles/mcphead-test`）。
