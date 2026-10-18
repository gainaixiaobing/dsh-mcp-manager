# 端到端验证（可选）

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
curl -s http://127.0.0.1:<port>/mcp-manager/api/state | jq .
curl -s -X POST -H 'content-type: application/json' \
  -d '{"method":"setEnabled","params":{"server":"<name>","enabled":false}}' \
  http://127.0.0.1:<port>/mcp-manager/api/action
```

验证完删除临时 profile（`rm -rf ~/.dsh/profiles/mcphead-test`）。
