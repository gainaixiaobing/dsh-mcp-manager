/**
 * dsh-mcp-manager —— Web UI 半区（v0.3）。
 *
 * 在 Harness 设置页新增「MCP 服务」分区：
 *   - 健康概览：状态计数、探针成功率、全部探测、自动探测开关；
 *   - 列表：来源/状态/传输/端点/工具数、收藏、标签、备注、探针历史色点；
 *   - 操作：启停开关、握手探针（延迟/工具数/错误）、编辑（含高级配置）、删除；
 *   - 工具中心：跨服务搜索工具目录，点开单个工具可看 JSON Schema 并试用；
 *   - 新增：表单接入 streamable-http / stdio；
 *   - 导入：粘贴 mcpServers JSON、扫描本机客户端配置、按扫描出的文件路径导入；
 *   - 导出：cordis.patch.yml 片段（受管/含 profile 行）/ mcpServers JSON / Markdown / diagnostics。
 *
 * 与 Host 半区的契约见 docs/v0.3-api.md（已冻结）：
 *   GET  /mcp-manager/api/state           → { ok, servers[], summary, prefs, ... }
 *   POST /mcp-manager/api/action {method} → { ok, result }
 * 请求头带 `x-mcp-manager-token`（宿主注入 window.__MCP_MANAGER_TOKEN__）。
 * 只 require('react')，其它依赖全部来自宿主主题变量；无构建步骤。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mcp-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /**
     * DSH locale 服务是「扁平 key 查表」：`t('a.b')` 直接取 `dict['a.b']`，
     * 不会按 `.` 遍历嵌套对象。这里把嵌套字典压平，避免出现 `nav.label` 这种原始 key。
     */
    function flattenDictionary(input, prefix = '') {
      const out = {};
      for (const [key, value] of Object.entries(input ?? {})) {
        const full = prefix === '' ? key : `${prefix}.${key}`;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          Object.assign(out, flattenDictionary(value, full));
        } else {
          out[full] = String(value);
        }
      }
      return out;
    }

    const NS = 'mcp-manager';
    const API_STATE = '/mcp-manager/api/state';
    const API_ACTION = '/mcp-manager/api/action';
    const AUTO_REFRESH_MS = 15000;
    const STATUS_KEYS = ['connected', 'disabled', 'no-tools', 'failed', 'not-provisioned'];
    /** 详情区最多渲染多少字符（host 已按 64KB 截断，这里再兜一层防止 UI 卡顿）。 */
    const RESULT_PREVIEW_CHARS = 20000;
    /** 工具中心一次最多拉取多少条工具。 */
    const TOOL_CENTER_LIMIT = 200;
    /** 行内探针历史画几个色点。 */
    const HISTORY_DOTS = 8;
    /** 视图模式（按应用 / 平铺）的 localStorage 键。 */
    const VIEW_STORAGE_KEY = 'dsh-mcp-manager:view';
    /** 手动应用归类名长度上限（与 host prefs 限制一致）。 */
    const APP_NAME_LIMIT = 40;
    /** 高级配置的数值边界（与 host normalizeReconnect / maxInstructionBytes 对齐）。 */
    const RECONNECT_LIMITS = {
      initialDelayMs: [100, 60000],
      maxDelayMs: [100, 300000],
      maxAttempts: [1, 100],
    };
    const MAX_INSTRUCTION_BYTES = [1024, 1048576];

    const zh = {
      nav: { label: 'MCP 服务' },
      title: 'MCP 服务管理器',
      subtitle: '管理本机 MCP 服务：启停、探针、编辑、工具试用与导入导出。受管连接会持久化到 profile 作用域的存储文件。',
      refresh: '刷新',
      loading: '读取中…',
      empty: '当前没有匹配的 MCP 服务。',
      errorApi: '管理 API 不可用，请确认 dsh-mcp-manager 已启用且 webApi 为 true。',
      column: { server: '服务', status: '状态', transport: '传输', tools: '工具', actions: '操作' },
      status: { connected: '已连接', disabled: '已停用', 'no-tools': '无工具', failed: '加载失败', 'not-provisioned': '未生效' },
      origin: { profile: 'profile', managed: '受管' },
      duplicate: '同名',
      duplicateHint: '该服务被多个条目重复声明（profile 静态行 + 受管记录），共享同一工具命名空间；启停请以条目 id/来源区分。',
      summary: '{total} 个条目 · 唯一服务 {unique} 个 · 受管 {managed} 条 · {enabled} 启用 / {connected} 已连接 / {disabled} 停用 · 工具 {tools} 个',
      toolCount: '{count} 个',
      showTools: '查看工具',
      hideTools: '收起工具',
      noTools: '没有已注册的工具（可能连接失败或服务本身不提供工具）',
      probe: '探针',
      probing: '探测中…',
      edit: '编辑',
      remove: '删除',
      confirmRemove: '确认删除',
      cancel: '取消',
      save: '保存',
      saving: '保存中…',
      add: '新增',
      import: '导入',
      export: '导出',
      close: '关闭',
      searchPlaceholder: '搜索服务名 / 端点 / 传输…',
      allStatuses: '全部状态',
      toggleOn: '启用',
      toggleOff: '停用',
      runtimeOnly: 'profile 静态行：启停/编辑只对本次运行生效，重启恢复；持久化请导出 patch。',
      storePath: '受管存储：{path}',
      prefsPath: '偏好存储：{path}',
      storeError: '受管存储读取失败：{message}',
      prefsError: '偏好存储读取失败：{message}',
      provisionFailures: '有 {count} 条受管记录未生效：',
      toggleFailed: '操作失败：{message}',
      probeOk: '{latency}ms · {count} 个工具',
      copyDiagnostics: '复制诊断',
      probeFailed: '探测失败：{message}',
      probeStderr: 'stderr（已脱敏）',
      pin: { pin: '收藏', unpin: '取消收藏' },
      tags: { label: '标签', edit: '编辑标签', add: '添加标签', placeholder: '标签，用逗号分隔', save: '保存标签' },
      note: { add: '添加备注', edit: '编辑备注', placeholder: '备注（只存本地偏好文件）', save: '保存备注', label: '备注' },
      history: { label: '最近探测', ok: '成功', fail: '失败', none: '暂无探针历史' },
      view: { apps: '按应用', flat: '平铺', label: '视图' },
      apps: {
        filterLabel: '应用',
        filterAll: '全部应用',
        independent: '独立服务',
        services: '{count} 个服务',
        healthSummary: '{connected} 已连接 · {failed} 失败 · {disabled} 停用',
        rename: '重命名',
        restore: '恢复自动识别',
        renamePlaceholder: '应用名称',
        save: '保存',
        cancel: '取消',
        renamed: '已重命名为 {name}',
        restored: '已恢复自动识别',
        renameFailed: '应用重命名失败：{message}',
        appSaveFailed: '应用归类保存失败：{message}',
        manual: '手动归类',
        badgeTitle: '应用：{name}',
        empty: '当前筛选下没有可显示的 MCP 服务。',
      },
      health: {
        statusLabel: '状态',
        successRate: '近期探针成功 {ok}/{total}（{pct}%）',
        noHistory: '还没有探针历史；可点「全部探测」生成。',
        probeAll: '全部探测',
        probingCount: '已探测 {done}/{total}',
        probeAllDone: '已探测 {done}/{total}，成功 {ok} 个',
        probeAllFailed: '批量探测失败：{message}',
        autoProbe: '自动探测',
        autoProbeHint: '打开面板时自动探测已启用服务',
        autoProbeFailed: '自动探测设置失败：{message}',
      },
      notice: {
        serverAdded: '已接入 {name}',
        serverUpdated: '已更新 {name}',
        serverRemoved: '已移除 {name}',
        removeFailed: '移除失败：{message}',
        pinFailed: '收藏失败：{message}',
        tagsFailed: '标签保存失败：{message}',
        noteFailed: '备注保存失败：{message}',
        probeFailed: '探测失败：{message}',
      },
      form: {
        addTitle: '接入新的 MCP 服务',
        editTitle: '编辑 MCP 服务：{name}',
        serverName: '服务名（工具命名空间）',
        serverNameHint: '1-32 位字母/数字/下划线/连字符；会成为 mcp__<serverName>__<tool>。',
        transport: '传输方式',
        url: 'MCP 端点 URL',
        urlMaskedHint: 'URL 里含凭据，已掩码；留空表示保持原值。',
        headers: '请求头 JSON（可选；留空保持现有）',
        headersHint: '例如 {"Authorization": "Bearer ..."}；凭据只写入受管存储，不会回显。',
        command: '可执行文件',
        args: '参数 JSON 数组（可选）',
        env: '环境变量 JSON（可选；留空保持现有）',
        envHint: '例如 {"API_KEY": "..."}；凭据只写入受管存储，不会回显。',
        cwd: '工作目录（可选）',
        timeout: '工具调用超时（毫秒）',
        app: '应用归类',
        appHint: '留空表示自动识别（当前识别为 {name}）',
        appPlaceholder: '留空 = 自动识别',
        enabled: '保存后立即启用',
        existingSecrets: '已有凭据字段：{keys}（留空表示保持不变）',
        clearHeaders: '清空现有请求头',
        clearEnv: '清空现有环境变量',
        noExistingSecrets: '当前没有凭据字段',
        invalidJson: 'JSON 解析失败：{message}',
        saveFailed: '保存失败：{message}',
      },
      advanced: {
        title: '高级配置',
        reconnectEnabled: '启用自动重连',
        initialDelayMs: '初始重连延迟（毫秒）',
        maxDelayMs: '最大重连延迟（毫秒）',
        maxAttempts: '最大重试次数',
        failOnStartupError: '启动失败时标记失败',
        maxInstructionBytes: '指令字节上限',
        hint: '高级字段会写入 MCP 客户端条目配置；不确定时保持默认。',
      },
      importer: {
        title: '导入 MCP 配置',
        pasteLabel: '粘贴 mcpServers JSON',
        pasteHint: '支持 {"mcpServers": {...}}、{"servers": {...}}、直接映射或数组。',
        fileLabel: '从本机配置路径导入',
        fileHint: '只接受「扫描本机配置」结果里出现的文件路径。',
        filePlaceholder: '/Users/you/.cursor/mcp.json',
        scan: '扫描本机配置',
        scanning: '扫描中…',
        noScan: '还没有扫描结果',
        sources: '发现 {count} 个配置文件',
        useSource: '填入此路径',
        candidates: '可导入条目',
        selected: '已选 {count} 个',
        previewTitle: '预览结果',
        conflict: '已存在',
        preview: '预览',
        confirm: '确认导入',
        importing: '导入中…',
        result: '已导入 {count} 个，失败 {failed} 个',
        previewResult: '预览到 {count} 个可导入条目',
        onConflict: '同名冲突：',
        conflictSkip: '跳过',
        conflictOverwrite: '覆盖受管记录',
        conflictRename: '自动改名（-2/-3…）',
        importEnabled: '导入后启用',
        needSource: '请粘贴 JSON、填入扫描到的文件路径，或勾选扫描结果中的条目。',
        scanFailed: '扫描失败：{message}',
        importFailed: '导入失败：{message}',
        previewFailed: '预览失败：{message}',
        errors: '失败/跳过：',
      },
      exporter: {
        title: '导出配置',
        patch: 'patch（cordis.patch.yml）',
        json: 'mcpServers JSON',
        markdown: 'Markdown 清单',
        diagnostics: 'diagnostics（排障报告）',
        scope: '导出范围（patch）',
        scopeManaged: '仅受管（默认）',
        scopeAll: '含 profile 行',
        scopeHint: 'patch 默认只导出受管记录；含 profile 行会生成覆盖式 patch，不要直接 insert。',
        download: '下载文件',
        copy: '复制',
        copied: '已复制',
        warnings: '提示：',
        failed: '导出失败：{message}',
      },
      tools: {
        center: '工具中心',
        searchPlaceholder: '搜索工具名 / 服务名 / 描述…',
        search: '搜索',
        refresh: '刷新目录',
        total: '共 {total} 个工具，返回 {returned} 个',
        truncated: '（已截断，仅显示前 {returned} 个，请用关键词收窄）',
        empty: '没有匹配的工具。',
        loading: '加载工具目录…',
        loadFailed: '加载工具目录失败：{message}',
        clickHint: '点击工具可查看参数并试用',
        count: '{count} 个工具',
      },
      drawer: {
        title: '试用工具：{tool}',
        close: '关闭',
        loading: '读取工具定义…',
        loadFailed: '读取工具定义失败：{message}',
        description: '描述',
        schema: '参数 Schema（JSON）',
        showSchema: '展开 Schema',
        hideSchema: '收起 Schema',
        arguments: '调用参数（JSON）',
        sample: '用示例参数',
        invalidJson: '参数不是合法 JSON：{message}',
        argsObject: '参数必须是 JSON 对象',
        dryRun: '预览（dryRun）',
        execute: '执行',
        confirmExecute: '确认执行（可能产生副作用）',
        cancelConfirm: '取消',
        confirmHint: '该操作会真实调用 MCP 工具，可能修改数据或产生外部副作用。请确认参数无误。',
        running: '调用中…',
        result: '调用结果',
        resultOk: '成功 · {duration}ms',
        resultError: '失败 · {message}',
        code: '错误码：{code}',
        truncated: '结果已截断（host 或界面预览上限），可复制完整文本再查看。',
        copy: '复制结果',
        copied: '已复制',
        copyFailed: '复制失败：{message}',
        noResult: '还没有调用结果。',
        dryRunDone: 'dryRun 预览通过（未真实执行）。',
        emptyText: '（无文本输出）',
        server: '服务',
        tool: '工具',
      },
    };

    const en = {
      nav: { label: 'MCP servers' },
      title: 'MCP server manager',
      subtitle: 'Manage local MCP servers: enable/disable, probe, edit, try tools, import and export. Managed connections persist to a profile-scoped store.',
      refresh: 'Refresh',
      loading: 'Loading…',
      empty: 'No matching MCP server.',
      errorApi: 'Management API unavailable. Check that dsh-mcp-manager is enabled and webApi is true.',
      column: { server: 'Server', status: 'Status', transport: 'Transport', tools: 'Tools', actions: 'Actions' },
      status: { connected: 'Connected', disabled: 'Disabled', 'no-tools': 'No tools', failed: 'Failed', 'not-provisioned': 'Not provisioned' },
      origin: { profile: 'profile', managed: 'managed' },
      duplicate: 'duplicate',
      duplicateHint: 'This server is declared by multiple entries sharing one tool namespace; use the entry id/source to tell them apart.',
      summary: '{total} entries · {unique} unique servers · {managed} managed · {enabled} enabled / {connected} connected / {disabled} disabled · {tools} tools',
      toolCount: '{count}',
      showTools: 'Show tools',
      hideTools: 'Hide tools',
      noTools: 'No tool is registered (connection may have failed, or the server exposes none)',
      probe: 'Probe',
      probing: 'Probing…',
      edit: 'Edit',
      remove: 'Remove',
      confirmRemove: 'Confirm remove',
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving…',
      add: 'Add',
      import: 'Import',
      export: 'Export',
      close: 'Close',
      searchPlaceholder: 'Search name / endpoint / transport…',
      allStatuses: 'All statuses',
      toggleOn: 'Enable',
      toggleOff: 'Disable',
      runtimeOnly: 'Profile-declared rows: enable/edit only affects this run; export a patch to persist.',
      storePath: 'Managed store: {path}',
      prefsPath: 'Prefs store: {path}',
      storeError: 'Managed store failed to load: {message}',
      prefsError: 'Prefs store failed to load: {message}',
      provisionFailures: '{count} managed record(s) not provisioned:',
      toggleFailed: 'Action failed: {message}',
      probeOk: '{latency}ms · {count} tools',
      copyDiagnostics: 'Copy diagnostics',
      probeFailed: 'Probe failed: {message}',
      probeStderr: 'stderr (sanitized)',
      pin: { pin: 'Pin', unpin: 'Unpin' },
      tags: { label: 'Tags', edit: 'Edit tags', add: 'Add tag', placeholder: 'Tags, comma separated', save: 'Save tags' },
      note: { add: 'Add note', edit: 'Edit note', placeholder: 'Note (local prefs only)', save: 'Save note', label: 'Note' },
      history: { label: 'Recent probes', ok: 'ok', fail: 'fail', none: 'No probe history yet' },
      view: { apps: 'By app', flat: 'Flat', label: 'View' },
      apps: {
        filterLabel: 'App',
        filterAll: 'All apps',
        independent: 'Standalone servers',
        services: '{count} servers',
        healthSummary: '{connected} connected · {failed} failed · {disabled} disabled',
        rename: 'Rename',
        restore: 'Restore auto',
        renamePlaceholder: 'App name',
        save: 'Save',
        cancel: 'Cancel',
        renamed: 'Renamed to {name}',
        restored: 'Restored automatic grouping',
        renameFailed: 'App rename failed: {message}',
        appSaveFailed: 'Saving app grouping failed: {message}',
        manual: 'Manual',
        badgeTitle: 'App: {name}',
        empty: 'No MCP server matches the current filters.',
      },
      health: {
        statusLabel: 'Status',
        successRate: 'Recent probes ok {ok}/{total} ({pct}%)',
        noHistory: 'No probe history yet; run "Probe all" to build one.',
        probeAll: 'Probe all',
        probingCount: 'Probed {done}/{total}',
        probeAllDone: 'Probed {done}/{total}, {ok} ok',
        probeAllFailed: 'Batch probe failed: {message}',
        autoProbe: 'Auto probe',
        autoProbeHint: 'Probe enabled servers when this panel opens',
        autoProbeFailed: 'Failed to update auto-probe: {message}',
      },
      notice: {
        serverAdded: 'Added {name}',
        serverUpdated: 'Updated {name}',
        serverRemoved: 'Removed {name}',
        removeFailed: 'Remove failed: {message}',
        pinFailed: 'Pin failed: {message}',
        tagsFailed: 'Saving tags failed: {message}',
        noteFailed: 'Saving note failed: {message}',
        probeFailed: 'Probe failed: {message}',
      },
      form: {
        addTitle: 'Add an MCP server',
        editTitle: 'Edit MCP server: {name}',
        serverName: 'Server name (tool namespace)',
        serverNameHint: '1-32 letters/digits/_/-; becomes mcp__<serverName>__<tool>.',
        transport: 'Transport',
        url: 'MCP endpoint URL',
        urlMaskedHint: 'The URL contains credentials and is masked; leave empty to keep the current value.',
        headers: 'Headers JSON (optional; leave empty to keep current)',
        headersHint: 'e.g. {"Authorization": "Bearer ..."}; credentials only go to the managed store and are never echoed back.',
        command: 'Command',
        args: 'Args JSON array (optional)',
        env: 'Env JSON (optional; leave empty to keep current)',
        envHint: 'e.g. {"API_KEY": "..."}; credentials only go to the managed store and are never echoed back.',
        cwd: 'Working directory (optional)',
        timeout: 'Tool call timeout (ms)',
        app: 'App grouping',
        appHint: 'Leave empty for automatic detection (currently: {name})',
        appPlaceholder: 'Empty = auto',
        enabled: 'Enable after save',
        existingSecrets: 'Existing credential fields: {keys} (leave empty to keep)',
        clearHeaders: 'Clear current headers',
        clearEnv: 'Clear current env',
        noExistingSecrets: 'No credential fields yet',
        invalidJson: 'Invalid JSON: {message}',
        saveFailed: 'Save failed: {message}',
      },
      advanced: {
        title: 'Advanced',
        reconnectEnabled: 'Enable auto-reconnect',
        initialDelayMs: 'Initial reconnect delay (ms)',
        maxDelayMs: 'Max reconnect delay (ms)',
        maxAttempts: 'Max reconnect attempts',
        failOnStartupError: 'Mark as failed on startup error',
        maxInstructionBytes: 'Max instruction bytes',
        hint: 'Advanced fields are written into the MCP client entry config; keep defaults if unsure.',
      },
      importer: {
        title: 'Import MCP configuration',
        pasteLabel: 'Paste mcpServers JSON',
        pasteHint: 'Supports {"mcpServers": {...}}, {"servers": {...}}, a raw map or an array.',
        fileLabel: 'Import from a local config path',
        fileHint: 'Only paths that appeared in "Scan local clients" results are expected.',
        filePlaceholder: '/Users/you/.cursor/mcp.json',
        scan: 'Scan local clients',
        scanning: 'Scanning…',
        noScan: 'No scan result yet',
        sources: '{count} config file(s) found',
        useSource: 'Use this path',
        candidates: 'Importable entries',
        selected: '{count} selected',
        previewTitle: 'Preview result',
        conflict: 'exists',
        preview: 'Preview',
        confirm: 'Import',
        importing: 'Importing…',
        result: 'Imported {count}, failed {failed}',
        previewResult: 'Previewed {count} entries',
        onConflict: 'On conflict:',
        conflictSkip: 'Skip',
        conflictOverwrite: 'Overwrite managed',
        conflictRename: 'Rename (-2/-3…)',
        importEnabled: 'Enable after import',
        needSource: 'Paste JSON, enter a scanned file path, or select entries from scan results.',
        scanFailed: 'Scan failed: {message}',
        importFailed: 'Import failed: {message}',
        previewFailed: 'Preview failed: {message}',
        errors: 'Failed / skipped:',
      },
      exporter: {
        title: 'Export configuration',
        patch: 'patch (cordis.patch.yml)',
        json: 'mcpServers JSON',
        markdown: 'Markdown inventory',
        diagnostics: 'diagnostics (troubleshooting report)',
        scope: 'Patch scope',
        scopeManaged: 'Managed only (default)',
        scopeAll: 'Include profile rows',
        scopeHint: 'patch exports managed records by default; including profile rows produces an overwrite-style patch — do not insert it directly.',
        download: 'Download',
        copy: 'Copy',
        copied: 'Copied',
        warnings: 'Notes:',
        failed: 'Export failed: {message}',
      },
      tools: {
        center: 'Tool center',
        searchPlaceholder: 'Search tool / server / description…',
        search: 'Search',
        refresh: 'Refresh catalog',
        total: '{total} tools total, {returned} returned',
        truncated: '(truncated to first {returned}; narrow with a keyword)',
        empty: 'No matching tool.',
        loading: 'Loading tool catalog…',
        loadFailed: 'Loading tool catalog failed: {message}',
        clickHint: 'Click a tool to inspect its schema and try it',
        count: '{count} tools',
      },
      drawer: {
        title: 'Try tool: {tool}',
        close: 'Close',
        loading: 'Loading tool definition…',
        loadFailed: 'Loading tool definition failed: {message}',
        description: 'Description',
        schema: 'Parameter schema (JSON)',
        showSchema: 'Show schema',
        hideSchema: 'Hide schema',
        arguments: 'Arguments (JSON)',
        sample: 'Use sample arguments',
        invalidJson: 'Arguments are not valid JSON: {message}',
        argsObject: 'Arguments must be a JSON object',
        dryRun: 'Preview (dryRun)',
        execute: 'Execute',
        confirmExecute: 'Confirm execute (may have side effects)',
        cancelConfirm: 'Cancel',
        confirmHint: 'This really invokes the MCP tool and may mutate data or cause external side effects. Double-check the arguments.',
        running: 'Calling…',
        result: 'Result',
        resultOk: 'OK · {duration}ms',
        resultError: 'Failed · {message}',
        code: 'Code: {code}',
        truncated: 'Result truncated (host or UI preview limit); copy the text for the full payload.',
        copy: 'Copy result',
        copied: 'Copied',
        copyFailed: 'Copy failed: {message}',
        noResult: 'No invocation result yet.',
        dryRunDone: 'dryRun preview passed (nothing was executed).',
        emptyText: '(no text output)',
        server: 'Server',
        tool: 'Tool',
      },
    };

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '900px', color: 'var(--dsw-alias-label-primary)', fontSize: '14px', lineHeight: '22px' },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' },
      title: { margin: 0, fontSize: '16px', fontWeight: 600 },
      subtitle: { margin: '6px 0 0', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      button: {
        appearance: 'none', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit',
        borderRadius: '8px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer', font: 'inherit', whiteSpace: 'nowrap',
      },
      primaryButton: {
        appearance: 'none', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.12))',
        color: 'inherit', borderRadius: '8px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer', font: 'inherit', whiteSpace: 'nowrap',
      },
      toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
      input: {
        font: 'inherit', fontSize: '13px', color: 'inherit', background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px', padding: '4px 8px', minWidth: 0,
      },
      textarea: {
        font: 'inherit', fontSize: '12px', color: 'inherit', background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px', padding: '6px 8px', width: '100%', boxSizing: 'border-box', resize: 'vertical',
      },
      summary: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', margin: 0 },
      error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #d0563b)', margin: 0, whiteSpace: 'pre-wrap' },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-status-success, #2f9e6e)', margin: 0, whiteSpace: 'pre-wrap' },
      warning: { fontSize: '12px', color: 'var(--dsw-alias-status-warning, #d08b24)', margin: 0, whiteSpace: 'pre-wrap' },
      table: { display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--dsw-alias-border-l2)' },
      row: { borderBottom: '1px solid var(--dsw-alias-border-l2)' },
      rowMain: { display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) 86px 96px 104px 200px', alignItems: 'center', gap: '10px', padding: '10px 2px' },
      serverName: { fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      endpoint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', whiteSpace: 'nowrap' },
      dot: { width: '8px', height: '8px', borderRadius: '50%', flex: 'none' },
      tag: { fontSize: '11px', padding: '0 6px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)', marginLeft: '6px', flex: 'none' },
      link: { appearance: 'none', border: 0, background: 'transparent', padding: 0, fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' },
      toolList: { display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '0 2px 10px' },
      toolChip: {
        font: 'inherit', fontSize: '12px', padding: '2px 8px', borderRadius: '999px', background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.12))',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', border: 0, color: 'inherit', cursor: 'pointer',
      },
      actions: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '6px' },
      switchButton: {
        appearance: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '999px', width: '40px', height: '22px',
        padding: 0, cursor: 'pointer', position: 'relative', background: 'transparent', flex: 'none',
      },
      knob: { position: 'absolute', top: '2px', width: '16px', height: '16px', borderRadius: '50%', transition: 'left .15s ease' },
      panel: {
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', padding: '12px',
        display: 'flex', flexDirection: 'column', gap: '10px', background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.06))',
      },
      panelTitle: { margin: 0, fontSize: '14px', fontWeight: 600 },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      fieldRow: { display: 'flex', gap: '10px', flexWrap: 'wrap' },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', whiteSpace: 'pre-wrap', margin: 0, maxHeight: '260px', overflow: 'auto' },
      candidateList: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '220px', overflow: 'auto' },
      candidate: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' },
      // v0.3 新增
      star: { appearance: 'none', border: 0, background: 'transparent', padding: '0 2px', font: 'inherit', fontSize: '14px', lineHeight: '18px', cursor: 'pointer', flex: 'none' },
      health: {
        display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 12px',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
      },
      healthRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
      history: { display: 'inline-flex', gap: '3px', alignItems: 'center', marginTop: '4px', flexWrap: 'wrap' },
      historyDot: { width: '7px', height: '7px', borderRadius: '50%', display: 'inline-block', flex: 'none' },
      tagRow: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px', marginTop: '2px' },
      noteBox: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap', margin: '2px 0 0' },
      inlineRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      advanced: { display: 'flex', flexDirection: 'column', gap: '8px', borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: '8px' },
      toolRow: {
        display: 'flex', flexDirection: 'column', gap: '2px', textAlign: 'left', alignItems: 'flex-start',
        appearance: 'none', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit',
        borderRadius: '8px', padding: '6px 8px', cursor: 'pointer', font: 'inherit', width: '100%',
      },
      toolRowName: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' },
      toolListBox: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '320px', overflow: 'auto' },
      overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.42)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '24px', boxSizing: 'border-box' },
      drawer: {
        width: 'min(760px, 92vw)', maxHeight: '92vh', overflow: 'auto', boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-primary, #fff)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '12px', padding: '16px',
        display: 'flex', flexDirection: 'column', gap: '10px', boxShadow: '0 12px 40px rgba(0,0,0,.28)',
      },
      drawerHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' },
      resultPre: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', whiteSpace: 'pre-wrap',
        wordBreak: 'break-word', margin: 0, maxHeight: '320px', overflow: 'auto',
        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.08))', borderRadius: '8px', padding: '8px',
      },
      scopeRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', fontSize: '12px' },
      notice: { fontSize: '12px', padding: '6px 10px', borderRadius: '8px', margin: 0 },
      // v0.4 按应用视图
      viewBar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
      groupCard: {
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.06))', overflow: 'hidden',
      },
      groupHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '8px 10px' },
      groupToggle: {
        appearance: 'none', border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer',
        font: 'inherit', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', padding: 0, textAlign: 'left',
      },
      groupIcon: { fontSize: '18px', lineHeight: '20px' },
      groupName: { fontWeight: 600, fontSize: '14px' },
      groupMeta: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      groupBody: { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '0 10px' },
      renameRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', padding: '0 10px 10px' },
    };

    const STATUS_COLORS = {
      connected: 'var(--dsw-alias-status-success, #2f9e6e)',
      disabled: 'var(--dsw-alias-label-secondary, #8a8a8a)',
      'no-tools': 'var(--dsw-alias-status-warning, #d08b24)',
      failed: 'var(--dsw-alias-state-error-primary, #d0563b)',
      'not-provisioned': 'var(--dsw-alias-status-warning, #d08b24)',
    };

    // ── 基础设施 ────────────────────────────────────────────────────────────

    function format(t, key, values) {
      const template = t(key);
      if (typeof template !== 'string') return key;
      return Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
        template,
      );
    }

    function tokenOf() {
      try {
        const token = globalThis.__MCP_MANAGER_TOKEN__;
        if (typeof token === 'string' && token !== '') return token;
      } catch {
        /* 某些沙箱里 globalThis 访问受限，继续走 meta 兜底 */
      }
      // host 还会注入 <meta name="mcp-manager-token">：即使内联脚本被 CSP/缓存影响也能拿到
      try {
        const meta = typeof document !== 'undefined'
          ? document.querySelector('meta[name="mcp-manager-token"]')
          : undefined;
        const content = meta?.getAttribute?.('content');
        return typeof content === 'string' ? content : '';
      } catch {
        return '';
      }
    }

    async function request(url, options) {
      const headers = {
        accept: 'application/json',
        'x-mcp-manager-token': tokenOf(),
        ...(options?.body ? { 'content-type': 'application/json' } : {}),
      };
      const response = await fetch(url, { cache: 'no-store', ...options, headers });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.ok || !payload?.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
      return payload;
    }

    const api = {
      state: () => request(API_STATE),
      action: (method, params) => request(API_ACTION, {
        method: 'POST',
        body: JSON.stringify({ method, params: params ?? {} }),
      }).then((payload) => payload.result ?? payload),
    };

    async function copyText(text) {
      if (typeof navigator === 'undefined' || typeof navigator?.clipboard?.writeText !== 'function') {
        throw new Error('clipboard-unavailable');
      }
      await navigator.clipboard.writeText(String(text ?? ''));
    }

    async function copyDiagnostics(result) {
      const lines = [
        result?.error ?? '',
        result?.exitCode !== undefined ? `exitCode=${result.exitCode}` : '',
        result?.stderr ?? '',
      ].filter(Boolean);
      try {
        await copyText(lines.join('\n'));
      } catch {
        /* 剪贴板不可用时忽略 */
      }
    }

    // ── 数据读取（对可选字段全部做防御式读取）─────────────────────────────

    function prefsServersOf(state) {
      const servers = state?.prefs?.servers;
      return servers !== null && typeof servers === 'object' ? servers : {};
    }

    function prefsOf(state, server) {
      const map = prefsServersOf(state);
      const name = server?.serverName;
      const value = typeof name === 'string' ? map[name] : undefined;
      return value !== null && typeof value === 'object' ? value : {};
    }

    function isPinned(server, prefs) {
      if (typeof server?.pinned === 'boolean') return server.pinned;
      return prefs?.pinned === true;
    }

    function toolNamesOf(server) {
      return Array.isArray(server?.toolNames) ? server.toolNames : [];
    }

    function historyOf(server, prefs) {
      const list = Array.isArray(prefs?.history) ? prefs.history : Array.isArray(server?.history) ? server.history : [];
      return list.slice(-HISTORY_DOTS);
    }

    function remoteNameOf(result) {
      const remote = result?.serverNameRemote ?? result?.serverInfo?.name;
      return typeof remote === 'string' ? remote : '';
    }

    function probeRateText(t, prefsServers) {
      let ok = 0;
      let total = 0;
      for (const entry of Object.values(prefsServers ?? {})) {
        const history = Array.isArray(entry?.history) ? entry.history.slice(-HISTORY_DOTS) : [];
        for (const item of history) {
          total += 1;
          if (item?.ok === true) ok += 1;
        }
      }
      if (total === 0) return t('health.noHistory');
      return format(t, 'health.successRate', { ok, total, pct: Math.round((ok / total) * 100) });
    }

    function clampInt(value, min, max, fallback) {
      const parsed = Number.parseInt(String(value ?? ''), 10);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(Math.max(parsed, min), max);
    }

    function advancedChanges(form) {
      return {
        reconnect: {
          enabled: form.reconnectEnabled !== false,
          initialDelayMs: clampInt(form.initialDelayMs, ...RECONNECT_LIMITS.initialDelayMs, 500),
          maxDelayMs: clampInt(form.maxDelayMs, ...RECONNECT_LIMITS.maxDelayMs, 30000),
          maxAttempts: clampInt(form.maxAttempts, ...RECONNECT_LIMITS.maxAttempts, 10),
        },
        failOnStartupError: form.failOnStartupError === true,
        maxInstructionBytes: clampInt(form.maxInstructionBytes, ...MAX_INSTRUCTION_BYTES, 32768),
      };
    }

    // ── 视图模式 / 应用归类（v0.4）──────────────────────────────────────────

    function readStoredView() {
      try {
        const value = globalThis.localStorage?.getItem?.(VIEW_STORAGE_KEY);
        return value === 'flat' ? 'flat' : 'apps';
      } catch {
        return 'apps';
      }
    }

    function storeView(mode) {
      try {
        globalThis.localStorage?.setItem?.(VIEW_STORAGE_KEY, mode === 'flat' ? 'flat' : 'apps');
      } catch {
        /* localStorage 不可用时只丢失记忆，不影响功能 */
      }
    }

    /** 单个服务所属应用（host 正常会给 server.app；缺省时退化成独立服务）。 */
    function appOfServer(server) {
      const app = server?.app;
      if (app !== null && typeof app === 'object' && typeof app.id === 'string' && app.id !== '') return app;
      const name = String(server?.serverName ?? 'unknown');
      return { id: `server:${name}`, name, source: 'self', singleton: true };
    }

    /** state.apps（全量聚合）优先；旧 host 未提供时按 server.app 现场聚合。 */
    function appsOf(state) {
      const provided = Array.isArray(state?.apps)
        ? state.apps.filter((app) => app !== null && typeof app === 'object' && typeof app.id === 'string')
        : [];
      if (provided.length > 0) return provided;
      const servers = Array.isArray(state?.servers) ? state.servers : [];
      const groups = new Map();
      for (const server of servers) {
        const app = appOfServer(server);
        const group = groups.get(app.id) ?? {
          id: app.id,
          name: app.name,
          ...(app.icon ? { icon: app.icon } : {}),
          ...(app.vendor ? { vendor: app.vendor } : {}),
          source: app.source,
          singleton: true,
          serverIds: [],
          serverNames: [],
          total: 0,
          connected: 0,
          failed: 0,
          disabled: 0,
          noTools: 0,
          notProvisioned: 0,
          toolCount: 0,
          pinnedCount: 0,
        };
        group.serverIds.push(server.id);
        group.serverNames.push(server.serverName);
        group.total += 1;
        group.singleton = group.total <= 1;
        if (server.status === 'connected') group.connected += 1;
        else if (server.status === 'failed') group.failed += 1;
        else if (server.status === 'disabled') group.disabled += 1;
        else if (server.status === 'no-tools') group.noTools += 1;
        else if (server.status === 'not-provisioned') group.notProvisioned += 1;
        if (Number.isFinite(server.toolCount)) group.toolCount += server.toolCount;
        if (server.pinned === true) group.pinnedCount += 1;
        groups.set(app.id, group);
      }
      return [...groups.values()].sort((left, right) => right.total - left.total || left.name.localeCompare(right.name));
    }

    /** 服务排序：pinned → serverName → id（组内与独立服务区共用）。 */
    function compareServers(left, right, pinnedOf) {
      const pinnedDelta = (pinnedOf(right) ? 1 : 0) - (pinnedOf(left) ? 1 : 0);
      if (pinnedDelta !== 0) return pinnedDelta;
      return String(left.serverName ?? '').localeCompare(String(right.serverName ?? ''))
        || String(left.id ?? '').localeCompare(String(right.id ?? ''));
    }

    // ── 基础组件 ────────────────────────────────────────────────────────────

    function Badge({ t, status }) {
      const color = STATUS_COLORS[status] ?? STATUS_COLORS.disabled;
      return h('span', { style: styles.badge },
        h('span', { style: { ...styles.dot, background: color } }),
        h('span', null, t(`status.${status}`)));
    }

    function Tag({ children, title }) {
      return h('span', { style: styles.tag, title }, children);
    }

    function Switch({ t, enabled, busy, onToggle, ariaLabel }) {
      const label = ariaLabel ?? (enabled ? t('toggleOff') : t('toggleOn'));
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': enabled === true,
        'aria-label': label,
        title: label,
        disabled: busy,
        style: {
          ...styles.switchButton,
          background: enabled ? 'var(--dsw-alias-status-success, #2f9e6e)' : 'transparent',
          opacity: busy ? 0.5 : 1,
        },
        onClick: onToggle,
      }, h('span', { style: { ...styles.knob, left: enabled ? '20px' : '3px', background: enabled ? '#fff' : 'var(--dsw-alias-label-secondary)' } }));
    }

    function Field({ label, hint, children }) {
      return h('label', { style: styles.field },
        h('span', { style: styles.label }, label),
        children,
        hint ? h('span', { style: styles.hint }, hint) : null);
    }

    function PinStar({ t, pinned, busy, onToggle }) {
      const label = pinned ? t('pin.unpin') : t('pin.pin');
      return h('button', {
        type: 'button',
        'aria-pressed': pinned === true,
        'aria-label': label,
        title: label,
        disabled: busy,
        style: { ...styles.star, color: pinned ? 'var(--dsw-alias-status-warning, #d08b24)' : 'var(--dsw-alias-label-secondary)', opacity: busy ? 0.5 : 1 },
        onClick: onToggle,
      }, pinned ? '★' : '☆');
    }

    function ProbeHistoryDots({ t, history }) {
      const entries = Array.isArray(history) ? history.slice(-HISTORY_DOTS) : [];
      if (entries.length === 0) return null;
      return h('span', { style: styles.history, 'aria-label': t('history.label'), title: t('history.label') },
        entries.map((entry, index) => {
          const ok = entry?.ok === true;
          const at = Number(entry?.at);
          const when = Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : '';
          const latency = Number.isFinite(Number(entry?.latencyMs)) ? `${entry.latencyMs}ms` : '';
          const title = [when, ok ? t('history.ok') : t('history.fail'), latency].filter(Boolean).join(' · ');
          return h('span', {
            key: index,
            title,
            style: { ...styles.historyDot, background: ok ? 'var(--dsw-alias-status-success, #2f9e6e)' : 'var(--dsw-alias-state-error-primary, #d0563b)' },
          });
        }));
    }

    // ── 健康概览条 ──────────────────────────────────────────────────────────

    function HealthBar({
      t, statusCounts, statusFilter, onStatusFilter, rateText,
      probeAll, onProbeAll, autoProbe, autoProbeBusy, onToggleAutoProbe,
    }) {
      const busy = probeAll?.busy === true;
      const doneText = !busy && Number(probeAll?.total) > 0
        ? format(t, 'health.probeAllDone', { done: probeAll.total, total: probeAll.total, ok: probeAll.ok ?? 0 })
        : null;
      return h('div', { style: styles.health },
        h('div', { style: styles.healthRow },
          h('span', { style: styles.label }, t('health.statusLabel')),
          STATUS_KEYS.map((key) => h('button', {
            key,
            type: 'button',
            'aria-pressed': statusFilter === key,
            style: statusFilter === key ? { ...styles.primaryButton, borderColor: 'var(--dsw-alias-label-primary)' } : styles.button,
            onClick: () => onStatusFilter(statusFilter === key ? '' : key),
          }, `${t(`status.${key}`)} ${statusCounts?.[key] ?? 0}`))),
        h('div', { style: styles.healthRow },
          h('span', { style: styles.hint }, rateText),
          h('button', {
            type: 'button',
            style: styles.primaryButton,
            onClick: onProbeAll,
            disabled: busy,
            'aria-busy': busy,
          }, busy ? format(t, 'health.probingCount', { done: probeAll?.done ?? 0, total: probeAll?.total ?? 0 }) : t('health.probeAll')),
          doneText ? h('span', { role: 'status', style: styles.hint }, doneText) : null,
          h('span', { style: styles.label }, t('health.autoProbe')),
          h(Switch, { t, enabled: autoProbe === true, busy: autoProbeBusy, onToggle: onToggleAutoProbe, ariaLabel: t('health.autoProbe') }),
          h('span', { style: styles.hint }, t('health.autoProbeHint'))));
    }

    // ── 工具中心 ────────────────────────────────────────────────────────────

    function ToolCenter({ t, onOpenTool }) {
      const [open, setOpen] = React.useState(false);
      const [query, setQuery] = React.useState('');
      const [catalog, setCatalog] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');

      const load = async (searchTerm) => {
        setBusy(true);
        setError('');
        try {
          const result = await api.action('tools', { query: String(searchTerm ?? ''), limit: TOOL_CENTER_LIMIT });
          setCatalog(result ?? {});
        } catch (failure) {
          setError(format(t, 'tools.loadFailed', { message: String(failure?.message ?? failure) }));
        } finally {
          setBusy(false);
        }
      };

      React.useEffect(() => {
        if (!open) return;
        if (catalog !== undefined) return;
        load('');
      }, [open]);

      const tools = Array.isArray(catalog?.tools) ? catalog.tools : [];
      const total = Number.isFinite(Number(catalog?.total)) ? Number(catalog.total) : tools.length;
      const returned = Number.isFinite(Number(catalog?.returned)) ? Number(catalog.returned) : tools.length;
      const truncated = catalog?.truncated === true;

      return h('div', { style: styles.panel },
        h('div', { style: styles.healthRow },
          h('button', {
            type: 'button',
            style: styles.link,
            'aria-expanded': open === true,
            onClick: () => setOpen((value) => !value),
          }, `${open ? '▾' : '▸'} ${t('tools.center')}`),
          catalog !== undefined ? h('span', { style: styles.hint }, format(t, 'tools.total', { total, returned })) : null,
          truncated ? h('span', { style: styles.warning }, format(t, 'tools.truncated', { returned })) : null),
        open
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('div', { style: styles.healthRow },
              h('input', {
                style: { ...styles.input, flex: '1 1 220px' },
                value: query,
                placeholder: t('tools.searchPlaceholder'),
                'aria-label': t('tools.searchPlaceholder'),
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => {
                  if (event?.key === 'Enter') load(query);
                },
              }),
              h('button', { type: 'button', style: styles.button, onClick: () => load(query), disabled: busy }, busy ? t('loading') : t('tools.search')),
              h('button', { type: 'button', style: styles.button, onClick: () => load(query), disabled: busy }, t('tools.refresh'))),
            error ? h('p', { style: styles.error }, error) : null,
            busy && catalog === undefined ? h('p', { style: styles.hint }, t('tools.loading')) : null,
            tools.length === 0 && !busy && catalog !== undefined
              ? h('p', { style: styles.hint }, t('tools.empty'))
              : null,
            tools.length > 0
              ? h('div', null,
                h('p', { style: styles.hint }, t('tools.clickHint')),
                h('div', { style: styles.toolListBox },
                  tools.map((tool) => h('button', {
                    key: `${tool.serverName}/${tool.toolName}`,
                    type: 'button',
                    style: styles.toolRow,
                    title: String(tool.publicName ?? ''),
                    onClick: () => onOpenTool({ serverName: tool.serverName, toolName: tool.toolName }),
                  },
                  h('span', { style: styles.toolRowName }, String(tool.publicName ?? `${tool.serverName}/${tool.toolName}`)),
                  h('span', { style: styles.hint }, String(tool.description ?? ''))))))
              : null)
          : null);
    }

    // ── 工具试用抽屉 ────────────────────────────────────────────────────────

    function ToolDrawer({ t, selection, onClose }) {
      const [detail, setDetail] = React.useState(undefined);
      const [loading, setLoading] = React.useState(true);
      const [loadError, setLoadError] = React.useState('');
      const [argumentsText, setArgumentsText] = React.useState('');
      const [schemaOpen, setSchemaOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [confirming, setConfirming] = React.useState(false);
      const [result, setResult] = React.useState(undefined);
      const [error, setError] = React.useState('');
      const [copied, setCopied] = React.useState(false);
      const argsRef = React.useRef(null);

      const toolName = selection?.toolName ?? '';
      const serverKey = selection?.serverId ?? selection?.serverName ?? '';

      React.useEffect(() => {
        let active = true;
        setDetail(undefined);
        setLoading(true);
        setLoadError('');
        setArgumentsText('');
        setResult(undefined);
        setError('');
        setConfirming(false);
        setSchemaOpen(false);
        api.action('toolDetail', { server: serverKey, tool: toolName })
          .then((value) => {
            if (!active) return;
            setDetail(value);
            const sample = value?.sampleArguments;
            setArgumentsText(JSON.stringify(sample !== undefined ? sample : {}, null, 2));
          })
          .catch((failure) => {
            if (active) setLoadError(format(t, 'drawer.loadFailed', { message: String(failure?.message ?? failure) }));
          })
          .finally(() => {
            if (active) setLoading(false);
          });
        return () => { active = false; };
      }, [serverKey, toolName]);

      React.useEffect(() => {
        if (loading) return;
        if (argsRef.current && typeof argsRef.current.focus === 'function') argsRef.current.focus();
      }, [loading]);

      const parseArguments = () => {
        const trimmed = argumentsText.trim();
        if (trimmed === '') return {};
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch (failure) {
          throw new Error(format(t, 'drawer.invalidJson', { message: String(failure?.message ?? failure) }));
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error(t('drawer.argsObject'));
        }
        return parsed;
      };

      const invoke = async (dryRun) => {
        setBusy(true);
        setConfirming(false);
        setError('');
        try {
          const args = parseArguments();
          const value = await api.action('invoke', {
            server: serverKey,
            tool: toolName,
            arguments: args,
            ...(dryRun ? { dryRun: true } : {}),
          });
          setResult(value ?? {});
          setConfirming(false);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(false);
        }
      };

      const onExecuteClick = () => {
        if (!confirming) {
          setConfirming(true);
          return;
        }
        invoke(false);
      };

      const fillSample = () => {
        const sample = detail?.sampleArguments;
        setArgumentsText(JSON.stringify(sample !== undefined ? sample : {}, null, 2));
      };

      const fullText = typeof result?.text === 'string' ? result.text : '';
      const shownText = fullText.length > RESULT_PREVIEW_CHARS ? fullText.slice(0, RESULT_PREVIEW_CHARS) : fullText;
      const truncated = result?.truncated === true || fullText.length > RESULT_PREVIEW_CHARS;
      const resultOk = result?.ok === true && result?.isError !== true;

      const copyResult = async () => {
        try {
          await copyText(fullText);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch (failure) {
          setError(format(t, 'drawer.copyFailed', { message: String(failure?.message ?? failure) }));
        }
      };

      const onKeyDown = (event) => {
        if (event?.key === 'Escape') onClose();
      };

      return h('div', { style: styles.overlay, role: 'presentation' },
        h('div', {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': format(t, 'drawer.title', { tool: toolName }),
          tabIndex: -1,
          style: styles.drawer,
          onKeyDown,
        },
        h('div', { style: styles.drawerHeader },
          h('h4', { style: styles.panelTitle }, format(t, 'drawer.title', { tool: toolName })),
          h('button', { type: 'button', style: styles.button, onClick: onClose }, t('drawer.close'))),
        h('p', { style: styles.hint },
          `${t('drawer.server')}: ${detail?.serverName ?? selection?.serverName ?? ''} · ${t('drawer.tool')}: ${detail?.publicName ?? toolName}`),
        loading ? h('p', { style: styles.hint }, t('drawer.loading')) : null,
        loadError ? h('p', { style: styles.error }, loadError) : null,
        detail
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('div', null,
              h('span', { style: styles.label }, t('drawer.description')),
              h('p', { style: styles.hint }, String(detail.description ?? '—'))),
            h('div', null,
              h('button', {
                type: 'button',
                style: styles.link,
                'aria-expanded': schemaOpen === true,
                onClick: () => setSchemaOpen((value) => !value),
              }, schemaOpen ? t('drawer.hideSchema') : t('drawer.showSchema')),
              schemaOpen
                ? h('pre', { style: { ...styles.code, maxHeight: '220px' } }, JSON.stringify(detail.parameters ?? {}, null, 2))
                : null),
            h(Field, { label: t('drawer.arguments') },
              h('textarea', {
                ref: argsRef,
                style: { ...styles.textarea, minHeight: '96px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
                value: argumentsText,
                'aria-label': t('drawer.arguments'),
                onChange: (event) => setArgumentsText(event.target.value),
              })),
            h('div', { style: styles.healthRow },
              h('button', { type: 'button', style: styles.button, onClick: fillSample }, t('drawer.sample')),
              h('button', { type: 'button', style: styles.button, onClick: () => invoke(true), disabled: busy }, busy ? t('drawer.running') : t('drawer.dryRun')),
              h('button', {
                type: 'button',
                style: confirming ? { ...styles.primaryButton, borderColor: 'var(--dsw-alias-state-error-primary, #d0563b)' } : styles.primaryButton,
                onClick: onExecuteClick,
                disabled: busy,
              }, busy ? t('drawer.running') : confirming ? t('drawer.confirmExecute') : t('drawer.execute')),
              confirming
                ? h('button', { type: 'button', style: styles.button, onClick: () => setConfirming(false), disabled: busy }, t('drawer.cancelConfirm'))
                : null),
            confirming ? h('p', { style: styles.warning }, t('drawer.confirmHint')) : null,
            error ? h('p', { style: styles.error }, error) : null,
            result
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
                  h('span', { style: resultOk ? styles.ok : styles.error },
                    resultOk
                      ? format(t, 'drawer.resultOk', { duration: result?.durationMs ?? 0 })
                      : format(t, 'drawer.resultError', { message: result?.error?.message ?? result?.message ?? '' })),
                  h('button', { type: 'button', style: styles.button, onClick: copyResult }, copied ? t('drawer.copied') : t('drawer.copy'))),
                result?.code ? h('p', { style: styles.hint }, format(t, 'drawer.code', { code: result.code })) : null,
                result?.dryRun === true ? h('p', { style: styles.ok }, t('drawer.dryRunDone')) : null,
                truncated ? h('p', { style: styles.warning }, t('drawer.truncated')) : null,
                h('pre', { style: styles.resultPre }, shownText === '' ? t('drawer.emptyText') : shownText))
              : h('p', { style: styles.hint }, t('drawer.noResult')))
          : null));
    }

    // ── 高级配置折叠区 ──────────────────────────────────────────────────────

    function AdvancedFields({ t, form, update, open, onToggle }) {
      return h('div', { style: styles.advanced },
        h('button', {
          type: 'button',
          style: styles.link,
          'aria-expanded': open === true,
          onClick: onToggle,
        }, `${open ? '▾' : '▸'} ${t('advanced.title')}`),
        open
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('label', { style: styles.candidate },
              h('input', {
                type: 'checkbox',
                checked: form.reconnectEnabled !== false,
                'aria-label': t('advanced.reconnectEnabled'),
                onChange: update('reconnectEnabled'),
              }),
              t('advanced.reconnectEnabled')),
            h('div', { style: styles.fieldRow },
              h(Field, { label: t('advanced.initialDelayMs') },
                h('input', {
                  style: styles.input, type: 'number', min: 100, max: 60000,
                  value: form.initialDelayMs, 'aria-label': t('advanced.initialDelayMs'), onChange: update('initialDelayMs'),
                })),
              h(Field, { label: t('advanced.maxDelayMs') },
                h('input', {
                  style: styles.input, type: 'number', min: 100, max: 300000,
                  value: form.maxDelayMs, 'aria-label': t('advanced.maxDelayMs'), onChange: update('maxDelayMs'),
                })),
              h(Field, { label: t('advanced.maxAttempts') },
                h('input', {
                  style: styles.input, type: 'number', min: 1, max: 100,
                  value: form.maxAttempts, 'aria-label': t('advanced.maxAttempts'), onChange: update('maxAttempts'),
                }))),
            h('label', { style: styles.candidate },
              h('input', {
                type: 'checkbox',
                checked: form.failOnStartupError === true,
                'aria-label': t('advanced.failOnStartupError'),
                onChange: update('failOnStartupError'),
              }),
              t('advanced.failOnStartupError')),
            h(Field, { label: t('advanced.maxInstructionBytes') },
              h('input', {
                style: styles.input, type: 'number', min: 1024, max: 1048576,
                value: form.maxInstructionBytes, 'aria-label': t('advanced.maxInstructionBytes'), onChange: update('maxInstructionBytes'),
              })),
            h('p', { style: styles.hint }, t('advanced.hint')))
          : null);
    }

    // ── 编辑/新增表单 ───────────────────────────────────────────────────────

    function emptyForm() {
      return {
        serverName: '',
        transport: 'streamable-http',
        url: '',
        headers: '',
        command: '',
        args: '[]',
        env: '',
        cwd: '',
        timeout: '180000',
        enabled: true,
        reconnectEnabled: true,
        initialDelayMs: '500',
        maxDelayMs: '30000',
        maxAttempts: '10',
        failOnStartupError: false,
        maxInstructionBytes: '32768',
      };
    }

    function formFromConfig(config) {
      const base = emptyForm();
      if (!config) return base;
      const advanced = config.advanced !== null && typeof config.advanced === 'object' ? config.advanced : {};
      const reconnect = advanced.reconnect !== null && typeof advanced.reconnect === 'object' ? advanced.reconnect : {};
      const masked = config.urlMasked === true;
      return {
        ...base,
        serverName: config.serverName ?? '',
        transport: config.transport === 'stdio' ? 'stdio' : 'streamable-http',
        url: masked ? '' : (config.url ?? ''),
        command: config.command ?? '',
        args: JSON.stringify(config.args ?? [], null, 2),
        cwd: config.cwd ?? '',
        timeout: String(config.toolCallTimeoutMs ?? 180000),
        enabled: config.enabled !== false,
        reconnectEnabled: reconnect.enabled !== false,
        initialDelayMs: String(reconnect.initialDelayMs ?? 500),
        maxDelayMs: String(reconnect.maxDelayMs ?? 30000),
        maxAttempts: String(reconnect.maxAttempts ?? 10),
        failOnStartupError: advanced.failOnStartupError === true,
        maxInstructionBytes: String(advanced.maxInstructionBytes ?? 32768),
      };
    }

    function EditPanel({ t, mode, server, manualApp, detectedApp, onClose, onSaved }) {
      const [form, setForm] = React.useState(emptyForm);
      const [config, setConfig] = React.useState(undefined);
      const [clear, setClear] = React.useState({ headers: false, env: false });
      const [advancedOpen, setAdvancedOpen] = React.useState(false);
      const [appName, setAppName] = React.useState(typeof manualApp === 'string' ? manualApp : '');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');

      const serverKey = server?.id ?? server?.serverName;

      React.useEffect(() => {
        if (mode !== 'edit' || !serverKey) return;
        let active = true;
        api.action('config', { server: serverKey })
          .then((result) => {
            if (!active) return;
            setConfig(result);
            setForm(formFromConfig(result));
          })
          .catch((failure) => active && setError(String(failure?.message ?? failure)));
        return () => { active = false; };
      }, [mode, serverKey]);

      const update = (field) => (event) => {
        const value = event?.target?.type === 'checkbox' ? event.target.checked : event.target.value;
        setForm((previous) => ({ ...previous, [field]: value }));
      };

      const submit = async () => {
        setBusy(true);
        setError('');
        try {
          const isAdd = mode === 'add';
          const transport = form.transport;
          const timeout = Number.parseInt(String(form.timeout || '180000'), 10);
          const toolCallTimeoutMs = Number.isFinite(timeout) && timeout >= 1000 ? timeout : 180000;
          const advanced = advancedChanges(form);
          const parseJson = (label, text) => {
            const trimmed = String(text ?? '').trim();
            if (trimmed === '') return undefined;
            try {
              return JSON.parse(trimmed);
            } catch (failure) {
              throw new Error(format(t, 'form.invalidJson', { message: `${label}: ${failure.message}` }));
            }
          };

          if (isAdd) {
            const params = {
              serverName: form.serverName.trim(),
              transport,
              enabled: form.enabled !== false,
              persist: true,
              toolCallTimeoutMs,
              ...advanced,
            };
            if (transport === 'streamable-http') {
              params.url = form.url.trim();
              const headers = parseJson(t('form.headers'), form.headers);
              if (headers !== undefined) params.headers = headers;
            } else {
              params.command = form.command.trim();
              const args = parseJson(t('form.args'), form.args);
              if (args !== undefined) params.args = args.map(String);
              const env = parseJson(t('form.env'), form.env);
              if (env !== undefined) params.env = env;
              if (form.cwd.trim() !== '') params.cwd = form.cwd.trim();
            }
            await api.action('add', params);
            onSaved(format(t, 'notice.serverAdded', { name: params.serverName }));
          } else {
            const changes = {
              toolCallTimeoutMs,
              ...advanced,
              ...(clear.headers ? { deleteHeaders: true } : {}),
              ...(clear.env ? { deleteEnv: true } : {}),
            };
            if (transport === 'streamable-http') {
              // urlMasked 时 URL 输入框留空 = 保持原值，不要把掩码串写回。
              if (form.url.trim() !== '') changes.url = form.url.trim();
              const headers = parseJson(t('form.headers'), form.headers);
              if (headers !== undefined) changes.headers = headers;
            } else {
              if (form.command.trim() !== '') changes.command = form.command.trim();
              const args = parseJson(t('form.args'), form.args);
              if (args !== undefined) changes.args = args.map(String);
              const env = parseJson(t('form.env'), form.env);
              if (env !== undefined) changes.env = env;
              if (form.cwd.trim() !== '') changes.cwd = form.cwd.trim();
            }
            const result = await api.action('update', { server: serverKey, changes });
            // 应用归类存在 prefs（不是连接配置）：update 成功后再写 patchPrefs.app。
            const nextApp = appName.trim() === '' ? null : appName.trim().slice(0, APP_NAME_LIMIT);
            try {
              await api.action('patchPrefs', { server: serverKey, patch: { app: nextApp } });
            } catch (failure) {
              setError(format(t, 'apps.appSaveFailed', { message: String(failure?.message ?? failure) }));
              return;
            }
            onSaved(
              result?.warning ?? format(t, 'notice.serverUpdated', { name: server?.serverName ?? '' }),
              result?.warning ? 'warn' : 'ok',
            );
          }
          onClose();
        } catch (failure) {
          setError(format(t, 'form.saveFailed', { message: String(failure?.message ?? failure) }));
        } finally {
          setBusy(false);
        }
      };

      const isHttp = form.transport === 'streamable-http';
      const secretKeys = config ? (isHttp ? config.headerKeys : config.envKeys) : [];
      const secretHint = Array.isArray(secretKeys) && secretKeys.length > 0
        ? format(t, 'form.existingSecrets', { keys: secretKeys.join(', ') })
        : t('form.noExistingSecrets');
      const urlMasked = mode === 'edit' && config?.urlMasked === true;

      return h('div', { style: styles.panel },
        h('h4', { style: styles.panelTitle }, mode === 'add'
          ? t('form.addTitle')
          : format(t, 'form.editTitle', { name: server?.serverName ?? '' })),
        h('div', { style: styles.fieldRow },
          mode === 'add'
            ? h(Field, { label: t('form.serverName'), hint: t('form.serverNameHint') },
              h('input', { style: styles.input, value: form.serverName, 'aria-label': t('form.serverName'), onChange: update('serverName'), placeholder: 'my-server' }))
            : null,
          h(Field, { label: t('form.transport') },
            h('select', { style: styles.input, value: form.transport, onChange: update('transport'), disabled: mode === 'edit', 'aria-label': t('form.transport') },
              h('option', { value: 'streamable-http' }, 'streamable-http'),
              h('option', { value: 'stdio' }, 'stdio')))),
        mode === 'edit'
          ? h(Field, {
            label: t('form.app'),
            hint: format(t, 'form.appHint', { name: String(detectedApp ?? server?.serverName ?? '') }),
          },
          h('input', {
            style: styles.input,
            value: appName,
            'aria-label': t('form.app'),
            placeholder: t('form.appPlaceholder'),
            onChange: (event) => setAppName(event.target.value),
          }))
          : null,
        isHttp
          ? h(Field, { label: t('form.url'), hint: urlMasked ? t('form.urlMaskedHint') : undefined },
            h('input', {
              style: styles.input,
              value: form.url,
              'aria-label': t('form.url'),
              onChange: update('url'),
              placeholder: urlMasked ? '' : 'https://example.com/mcp',
            }))
          : h('div', null,
            h(Field, { label: t('form.command') },
              h('input', { style: styles.input, value: form.command, 'aria-label': t('form.command'), onChange: update('command'), placeholder: 'npx' })),
            h(Field, { label: t('form.cwd') },
              h('input', { style: styles.input, value: form.cwd, 'aria-label': t('form.cwd'), onChange: update('cwd'), placeholder: '/path/to/workdir' }))),
        h('div', { style: styles.fieldRow },
          h(Field, { label: t('form.timeout') },
            h('input', { style: styles.input, type: 'number', min: 1000, value: form.timeout, 'aria-label': t('form.timeout'), onChange: update('timeout') }))),
        isHttp
          ? h(Field, { label: t('form.headers'), hint: `${t('form.headersHint')} ${secretHint}` },
            h('textarea', { style: { ...styles.textarea, minHeight: '56px' }, value: form.headers, 'aria-label': t('form.headers'), onChange: update('headers'), placeholder: '{"Authorization": "Bearer ..."}' }))
          : h('div', null,
            h(Field, { label: t('form.args') },
              h('textarea', { style: { ...styles.textarea, minHeight: '56px' }, value: form.args, 'aria-label': t('form.args'), onChange: update('args') })),
            h(Field, { label: t('form.env'), hint: `${t('form.envHint')} ${secretHint}` },
              h('textarea', { style: { ...styles.textarea, minHeight: '56px' }, value: form.env, 'aria-label': t('form.env'), onChange: update('env'), placeholder: '{"API_KEY": "..." }'}))),
        mode === 'edit' && config?.hasHeaders
          ? h('label', { style: styles.candidate },
            h('input', { type: 'checkbox', checked: clear.headers, onChange: (event) => setClear((previous) => ({ ...previous, headers: event.target.checked })) }),
            t('form.clearHeaders'))
          : null,
        mode === 'edit' && config?.hasEnv
          ? h('label', { style: styles.candidate },
            h('input', { type: 'checkbox', checked: clear.env, onChange: (event) => setClear((previous) => ({ ...previous, env: event.target.checked })) }),
            t('form.clearEnv'))
          : null,
        mode === 'add'
          ? h('label', { style: { ...styles.candidate, marginTop: '2px' } },
            h('input', { type: 'checkbox', checked: form.enabled !== false, onChange: update('enabled') }),
            t('form.enabled'))
          : null,
        h(AdvancedFields, { t, form, update, open: advancedOpen, onToggle: () => setAdvancedOpen((value) => !value) }),
        error ? h('p', { style: styles.error }, error) : null,
        h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
          h('button', { type: 'button', style: styles.button, onClick: onClose, disabled: busy }, t('cancel')),
          h('button', { type: 'button', style: styles.primaryButton, onClick: submit, disabled: busy }, busy ? t('saving') : t('save'))));
    }

    // ── 导入面板 ────────────────────────────────────────────────────────────

    function ImportPanel({ t, onClose, onImported }) {
      const [json, setJson] = React.useState('');
      const [filePath, setFilePath] = React.useState('');
      const [scan, setScan] = React.useState(undefined);
      const [scanning, setScanning] = React.useState(false);
      const [selected, setSelected] = React.useState({});
      const [preview, setPreview] = React.useState(undefined);
      const [conflictAction, setConflictAction] = React.useState('skip');
      const [importEnabled, setImportEnabled] = React.useState(true);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [message, setMessage] = React.useState('');

      const runScan = async () => {
        setScanning(true);
        setError('');
        try {
          const result = await api.action('scan', {});
          setScan(result);
          const next = {};
          for (const candidate of result?.candidates ?? []) {
            next[`${candidate.file}\u0000${candidate.serverName}`] = candidate.conflict !== true;
          }
          setSelected(next);
        } catch (failure) {
          setError(format(t, 'importer.scanFailed', { message: String(failure?.message ?? failure) }));
        } finally {
          setScanning(false);
        }
      };

      const doPreview = async () => {
        setBusy(true);
        setError('');
        setMessage('');
        try {
          if (json.trim() !== '') {
            const result = await api.action('import', { json, apply: false });
            setPreview({ kind: 'paste', result });
            setMessage(format(t, 'importer.previewResult', { count: result?.records?.length ?? 0 }));
            return;
          }
          if (filePath.trim() !== '') {
            const result = await api.action('import', { file: filePath.trim(), apply: false });
            setPreview({ kind: 'file', result });
            setMessage(format(t, 'importer.previewResult', { count: result?.records?.length ?? 0 }));
            return;
          }
          const groups = groupByFile(scan, selected);
          if (groups.length === 0) throw new Error(t('importer.needSource'));
          const results = [];
          for (const group of groups) {
            const result = await api.action('import', { file: group.file, servers: group.servers, apply: false });
            results.push({ group, result });
          }
          setPreview({ kind: 'scan', results });
          const count = results.reduce((sum, item) => sum + (item.result?.records?.length ?? 0), 0);
          setMessage(format(t, 'importer.previewResult', { count }));
        } catch (failure) {
          setError(format(t, 'importer.previewFailed', { message: String(failure?.message ?? failure) }));
        } finally {
          setBusy(false);
        }
      };

      const doImport = async () => {
        setBusy(true);
        setError('');
        try {
          if (json.trim() !== '') {
            const result = await api.action('import', { json, apply: true, onConflict: conflictAction, enabled: importEnabled });
            onImported(format(t, 'importer.result', { count: result?.imported?.length ?? 0, failed: result?.errors?.length ?? 0 }));
            onClose();
            return;
          }
          if (filePath.trim() !== '') {
            const result = await api.action('import', {
              file: filePath.trim(), apply: true, onConflict: conflictAction, enabled: importEnabled,
            });
            onImported(format(t, 'importer.result', { count: result?.imported?.length ?? 0, failed: result?.errors?.length ?? 0 }));
            onClose();
            return;
          }
          const groups = groupByFile(scan, selected);
          if (groups.length === 0) throw new Error(t('importer.needSource'));
          let imported = 0;
          let failed = 0;
          for (const group of groups) {
            const result = await api.action('import', {
              file: group.file, servers: group.servers, apply: true, onConflict: conflictAction, enabled: importEnabled,
            });
            imported += result?.imported?.length ?? 0;
            failed += result?.errors?.length ?? 0;
          }
          onImported(format(t, 'importer.result', { count: imported, failed }));
          onClose();
        } catch (failure) {
          setError(format(t, 'importer.importFailed', { message: String(failure?.message ?? failure) }));
        } finally {
          setBusy(false);
        }
      };

      const candidates = scan?.candidates ?? [];
      const sources = scan?.sources ?? [];
      const selectedCount = Object.values(selected).filter(Boolean).length;

      return h('div', { style: styles.panel },
        h('h4', { style: styles.panelTitle }, t('importer.title')),
        h(Field, { label: t('importer.pasteLabel'), hint: t('importer.pasteHint') },
          h('textarea', {
            style: { ...styles.textarea, minHeight: '90px' },
            value: json,
            'aria-label': t('importer.pasteLabel'),
            onChange: (event) => setJson(event.target.value),
            placeholder: '{"mcpServers": {"github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"]}}}',
          })),
        h(Field, { label: t('importer.fileLabel'), hint: t('importer.fileHint') },
          h('input', {
            style: styles.input,
            value: filePath,
            'aria-label': t('importer.fileLabel'),
            placeholder: t('importer.filePlaceholder'),
            onChange: (event) => setFilePath(event.target.value),
          })),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('button', { type: 'button', style: styles.button, onClick: runScan, disabled: scanning || busy }, scanning ? t('importer.scanning') : t('importer.scan')),
          scan ? h('span', { style: styles.hint }, format(t, 'importer.sources', { count: sources.length })) : h('span', { style: styles.hint }, t('importer.noScan'))),
        sources.length > 0
          ? h('div', { style: styles.candidateList },
            sources.map((source) => h('div', { key: String(source.file), style: styles.candidate },
              h('button', {
                type: 'button',
                style: styles.link,
                title: String(source.file ?? ''),
                onClick: () => setFilePath(String(source.file ?? '')),
              }, h('span', null, `[${source.clientName ?? source.client ?? ''}] ${source.file ?? ''}`)),
              h('span', { style: styles.hint }, t('importer.useSource')))))
          : null,
        candidates.length > 0
          ? h('div', null,
            h('div', { style: styles.label }, `${t('importer.candidates')} · ${format(t, 'importer.selected', { count: selectedCount })}`),
            h('div', { style: styles.candidateList },
              candidates.map((candidate) => {
                const key = `${candidate.file}\u0000${candidate.serverName}`;
                return h('label', { key, style: styles.candidate, title: candidate.file },
                  h('input', {
                    type: 'checkbox',
                    checked: selected[key] === true,
                    onChange: (event) => setSelected((previous) => ({ ...previous, [key]: event.target.checked })),
                  }),
                  h('span', null, `[${candidate.clientName}] ${candidate.serverName}`),
                  candidate.conflict ? h(Tag, { title: t('duplicateHint') }, t('importer.conflict')) : null,
                  h('span', { style: styles.hint }, `${candidate.transport}${candidate.error ? ` · ${candidate.error}` : ''}`));
              })))
          : null,
        preview
          ? h('div', null,
            h('div', { style: styles.label }, t('importer.previewTitle')),
            h('pre', { style: styles.code }, JSON.stringify(preview, null, 2).slice(0, 4000)))
          : null,
        message ? h('p', { style: styles.hint }, message) : null,
        error ? h('p', { style: styles.error }, error) : null,
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: styles.label }, t('importer.onConflict')),
          h('select', { style: styles.input, value: conflictAction, onChange: (event) => setConflictAction(event.target.value), 'aria-label': t('importer.onConflict') },
            h('option', { value: 'skip' }, t('importer.conflictSkip')),
            h('option', { value: 'overwrite' }, t('importer.conflictOverwrite')),
            h('option', { value: 'rename' }, t('importer.conflictRename'))),
          h('label', { style: styles.candidate },
            h('input', { type: 'checkbox', checked: importEnabled, onChange: (event) => setImportEnabled(event.target.checked) }),
            t('importer.importEnabled'))),
        h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
          h('button', { type: 'button', style: styles.button, onClick: onClose, disabled: busy }, t('cancel')),
          h('button', { type: 'button', style: styles.button, onClick: doPreview, disabled: busy }, t('importer.preview')),
          h('button', { type: 'button', style: styles.primaryButton, onClick: doImport, disabled: busy }, busy ? t('importer.importing') : t('importer.confirm'))));
    }

    function groupByFile(scan, selected) {
      const groups = new Map();
      for (const candidate of scan?.candidates ?? []) {
        const key = `${candidate.file}\u0000${candidate.serverName}`;
        if (selected[key] !== true) continue;
        const list = groups.get(candidate.file) ?? [];
        list.push(candidate.serverName);
        groups.set(candidate.file, list);
      }
      return [...groups.entries()].map(([file, servers]) => ({ file, servers }));
    }

    // ── 导出面板 ────────────────────────────────────────────────────────────

    function ExportPanel({ t, onClose }) {
      const [result, setResult] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false);
      const [copied, setCopied] = React.useState(false);
      const [error, setError] = React.useState('');
      const [includeProfile, setIncludeProfile] = React.useState(false);

      const run = async (format) => {
        setBusy(true);
        setError('');
        try {
          const params = { format };
          if (format === 'patch') params.includeProfile = includeProfile === true;
          const value = await api.action('export', params);
          setResult(value);
        } catch (failure) {
          setError(format(t, 'exporter.failed', { message: String(failure?.message ?? failure) }));
        } finally {
          setBusy(false);
        }
      };

      const download = () => {
        try {
          const content = String(result?.content ?? '');
          const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
          const href = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          const ext = result?.format === 'json' ? 'json' : result?.format === 'markdown' || result?.format === 'diagnostics' ? 'md' : 'yml';
          anchor.href = href;
          anchor.download = `mcp-manager-export.${ext}`;
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(href), 1000);
        } catch (failure) {
          setError(format(t, 'exporter.failed', { message: String(failure?.message ?? failure) }));
        }
      };

      const copy = async () => {
        try {
          await copyText(result?.content ?? '');
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch (failure) {
          setError(format(t, 'exporter.failed', { message: String(failure?.message ?? failure) }));
        }
      };

      const formats = [
        { format: 'patch', label: t('exporter.patch') },
        { format: 'json', label: t('exporter.json') },
        { format: 'markdown', label: t('exporter.markdown') },
        { format: 'diagnostics', label: t('exporter.diagnostics') },
      ];

      return h('div', { style: styles.panel },
        h('h4', { style: styles.panelTitle }, t('exporter.title')),
        h('div', { style: styles.healthRow },
          formats.map((item) => h('button', {
            key: item.format,
            type: 'button',
            style: styles.button,
            onClick: () => run(item.format),
            disabled: busy,
          }, item.label))),
        h('div', { style: styles.scopeRow },
          h('span', { style: styles.label }, t('exporter.scope')),
          h('label', { style: styles.candidate },
            h('input', {
              type: 'radio',
              name: 'mcp-manager-export-scope',
              checked: includeProfile === false,
              onChange: () => setIncludeProfile(false),
            }),
            t('exporter.scopeManaged')),
          h('label', { style: styles.candidate },
            h('input', {
              type: 'radio',
              name: 'mcp-manager-export-scope',
              checked: includeProfile === true,
              onChange: () => setIncludeProfile(true),
            }),
            t('exporter.scopeAll'))),
        h('p', { style: styles.hint }, t('exporter.scopeHint')),
        result
          ? h('div', null,
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
              h('span', { style: styles.label }, `${result.format} · ${result.recordCount ?? 0}`),
              h('div', { style: { display: 'flex', gap: '8px' } },
                h('button', { type: 'button', style: styles.button, onClick: download }, t('exporter.download')),
                h('button', { type: 'button', style: styles.button, onClick: copy }, copied ? t('exporter.copied') : t('exporter.copy')))),
            h('pre', { style: styles.code }, String(result.content ?? '')),
            result.warnings?.length
              ? h('div', null,
                h('div', { style: styles.label }, t('exporter.warnings')),
                result.warnings.map((warning, index) => h('p', { key: index, style: styles.hint }, `- ${warning}`)))
              : null)
          : null,
        error ? h('p', { style: styles.error }, error) : null,
        h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
          h('button', { type: 'button', style: styles.button, onClick: onClose, disabled: busy }, t('close'))));
    }

    // ── 应用组卡（v0.4）─────────────────────────────────────────────────────

    function AppGroupCard({
      t, app, servers, collapsed, onToggle, renderServer, onRename, onRestore, busy,
    }) {
      const [renaming, setRenaming] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const name = app?.name ?? '';
      const source = app?.source;
      const total = Number.isFinite(Number(app?.total)) ? Number(app.total) : servers.length;
      const connected = Number.isFinite(Number(app?.connected)) ? Number(app.connected) : 0;
      const failed = Number.isFinite(Number(app?.failed)) ? Number(app.failed) : 0;
      const disabled = Number.isFinite(Number(app?.disabled)) ? Number(app.disabled) : 0;
      const toolCount = Number.isFinite(Number(app?.toolCount)) ? Number(app.toolCount) : 0;

      const startRename = () => {
        setDraft(name);
        setRenaming(true);
      };
      const cancelRename = () => setRenaming(false);
      const commitRename = () => {
        setRenaming(false);
        onRename(draft);
      };

      return h('div', { style: styles.groupCard, role: 'group', 'aria-label': name },
        h('div', { style: styles.groupHeader },
          h('button', {
            type: 'button',
            style: styles.groupToggle,
            'aria-expanded': collapsed !== true,
            onClick: onToggle,
          },
          h('span', { style: styles.groupIcon, 'aria-hidden': 'true' }, String(app?.icon ?? '🧩')),
          h('span', { style: styles.groupName }, name),
          h('span', { style: styles.groupMeta }, format(t, 'apps.services', { count: total })),
          h('span', { style: styles.groupMeta }, format(t, 'apps.healthSummary', { connected, failed, disabled })),
          h('span', { style: styles.groupMeta }, format(t, 'toolCount', { count: toolCount })),
          source === 'manual' ? h(Tag, null, t('apps.manual')) : null),
          h('div', { style: styles.actions },
            h('button', { type: 'button', style: styles.link, onClick: startRename, disabled: busy }, t('apps.rename')),
            source === 'manual'
              ? h('button', { type: 'button', style: styles.link, onClick: onRestore, disabled: busy }, t('apps.restore'))
              : null)),
        renaming
          ? h('div', { style: styles.renameRow },
            h('input', {
              style: { ...styles.input, flex: '1 1 200px' },
              value: draft,
              'aria-label': t('apps.renamePlaceholder'),
              placeholder: t('apps.renamePlaceholder'),
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event?.key === 'Enter') commitRename();
                if (event?.key === 'Escape') cancelRename();
              },
            }),
            h('button', { type: 'button', style: styles.primaryButton, onClick: commitRename, disabled: busy }, t('apps.save')),
            h('button', { type: 'button', style: styles.button, onClick: cancelRename, disabled: busy }, t('apps.cancel')))
          : null,
        collapsed === true
          ? null
          : h('div', { style: styles.groupBody }, servers.map((server) => renderServer(server))));
    }

    // ── 服务行 ──────────────────────────────────────────────────────────────

    function ServerRow({
      t, server, prefs, pinned, probeResult, busy, prefsBusy, appLabel,
      onToggle, onProbe, onEdit, onRemove, onPin, onTags, onNote, onOpenTool,
    }) {
      const [expanded, setExpanded] = React.useState(false);
      const [confirming, setConfirming] = React.useState(false);
      const [tagEditing, setTagEditing] = React.useState(false);
      const [tagDraft, setTagDraft] = React.useState('');
      const [noteEditing, setNoteEditing] = React.useState(false);
      const [noteDraft, setNoteDraft] = React.useState('');
      const toolNames = toolNamesOf(server);
      const tags = Array.isArray(prefs?.tags) ? prefs.tags : [];
      const note = typeof prefs?.note === 'string' ? prefs.note : '';
      const remote = remoteNameOf(probeResult);
      const probeOk = probeResult ? (probeResult.ok === true || probeResult.reachable === true) : false;

      const startTags = () => {
        setTagDraft(tags.join(', '));
        setTagEditing(true);
      };
      const commitTags = () => {
        const next = tagDraft.split(',').map((value) => value.trim()).filter(Boolean).slice(0, 8);
        onTags(next.length > 0 ? next : null);
        setTagEditing(false);
      };
      const startNote = () => {
        setNoteDraft(note);
        setNoteEditing(true);
      };
      const commitNote = () => {
        const next = noteDraft.trim();
        onNote(next === '' ? null : next);
        setNoteEditing(false);
      };

      return h('div', { style: styles.row, role: 'row' },
        h('div', { style: styles.rowMain },
          h('div', { style: { minWidth: 0 }, role: 'cell' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 } },
              h(PinStar, { t, pinned, busy: prefsBusy, onToggle: () => onPin(!pinned) }),
              h('div', { style: styles.serverName, title: server.id }, server.serverName),
              h(Tag, { title: t('origin.' + server.origin) }, t('origin.' + server.origin)),
              server.duplicate ? h(Tag, { title: t('duplicateHint') }, t('duplicate')) : null,
              appLabel ? h(Tag, { title: format(t, 'apps.badgeTitle', { name: appLabel }) }, appLabel) : null),
            server.shortId && server.shortId !== server.serverName
              ? h('div', { style: styles.endpoint, title: server.id }, server.shortId)
              : null,
            server.endpoint ? h('div', { style: styles.endpoint, title: server.endpoint }, server.endpoint) : null,
            tags.length > 0 || tagEditing
              ? h('div', { style: styles.tagRow },
                tags.map((tag) => h(Tag, { key: tag }, `#${tag}`)),
                !tagEditing ? h('button', { type: 'button', style: styles.link, onClick: startTags }, t('tags.edit')) : null,
                tagEditing
                  ? h('span', { style: styles.inlineRow },
                    h('input', {
                      style: { ...styles.input, fontSize: '11px', padding: '2px 6px' },
                      value: tagDraft,
                      placeholder: t('tags.placeholder'),
                      'aria-label': t('tags.placeholder'),
                      onChange: (event) => setTagDraft(event.target.value),
                      onKeyDown: (event) => {
                        if (event?.key === 'Enter') commitTags();
                        if (event?.key === 'Escape') setTagEditing(false);
                      },
                    }),
                    h('button', { type: 'button', style: styles.link, onClick: commitTags }, t('tags.save')),
                    h('button', { type: 'button', style: styles.link, onClick: () => setTagEditing(false) }, t('cancel')))
                  : null)
              : h('button', { type: 'button', style: styles.link, onClick: startTags }, t('tags.add')),
            noteEditing
              ? h('div', { style: styles.inlineRow },
                h('textarea', {
                  style: { ...styles.textarea, minHeight: '40px', fontSize: '12px' },
                  value: noteDraft,
                  placeholder: t('note.placeholder'),
                  'aria-label': t('note.placeholder'),
                  onChange: (event) => setNoteDraft(event.target.value),
                }),
                h('button', { type: 'button', style: styles.link, onClick: commitNote }, t('note.save')),
                h('button', { type: 'button', style: styles.link, onClick: () => setNoteEditing(false) }, t('cancel')))
              : note !== ''
                ? h('div', { style: styles.inlineRow },
                  h('p', { style: styles.noteBox, title: note }, note),
                  h('button', { type: 'button', style: styles.link, onClick: startNote }, t('note.edit')))
                : h('button', { type: 'button', style: styles.link, onClick: startNote }, t('note.add')),
            h(ProbeHistoryDots, { t, history: historyOf(server, prefs) }),
            server.error ? h('div', { style: styles.error, title: server.error }, server.error) : null,
            probeResult
              ? h('div', null,
                h('div', { style: probeOk ? styles.hint : styles.error },
                  probeOk
                    ? format(t, 'probeOk', { latency: probeResult.latencyMs ?? 0, count: probeResult.toolCount ?? 0 }) + (remote ? ` · ${remote}` : '')
                    : format(t, 'probeFailed', { message: probeResult.error ?? '' })),
                probeOk ? null : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' } },
                  probeResult.exitCode !== undefined ? h('div', { style: styles.hint }, `exitCode=${probeResult.exitCode}`) : null,
                  probeResult.stderr
                    ? h('div', null,
                      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                        h('span', { style: styles.hint }, t('probeStderr')),
                        h('button', { type: 'button', style: styles.link, onClick: () => copyDiagnostics(probeResult) }, t('copyDiagnostics'))),
                      h('pre', { style: { ...styles.code, maxHeight: '140px' } }, probeResult.stderr))
                    : null))
              : null),
          h(Badge, { t, status: server.status }),
          h('span', { style: { fontSize: '12px' } }, server.transport),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' } },
            h('span', null, format(t, 'toolCount', { count: server.toolCount ?? 0 })),
            toolNames.length > 0
              ? h('button', { type: 'button', style: styles.link, 'aria-expanded': expanded, onClick: () => setExpanded((value) => !value) },
                expanded ? t('hideTools') : t('showTools'))
              : null),
          h('div', { style: styles.actions },
            h('button', { type: 'button', style: styles.button, onClick: onProbe, disabled: busy }, busy ? t('probing') : t('probe')),
            h('button', { type: 'button', style: styles.button, onClick: onEdit }, t('edit')),
            h('button', {
              type: 'button',
              style: styles.button,
              onClick: () => (confirming ? onRemove() : setConfirming(true)),
              onBlur: () => setConfirming(false),
            }, confirming ? t('confirmRemove') : t('remove')),
            h(Switch, { t, enabled: server.enabled, busy, onToggle: onToggle }))),
        expanded
          ? h('div', { style: styles.toolList },
            toolNames.length > 0
              ? toolNames.map((toolName) => h('button', {
                key: toolName,
                type: 'button',
                style: styles.toolChip,
                title: toolName,
                onClick: () => onOpenTool({ serverId: server.id, serverName: server.serverName, toolName }),
              }, toolName))
              : h('span', { style: styles.hint }, t('noTools')))
          : null);
    }

    // ── 主面板 ──────────────────────────────────────────────────────────────

    function McpManagerSection({ t }) {
      const [state, setState] = React.useState({
        phase: 'loading', servers: [], summary: null, prefs: {}, provisionFailures: {}, message: '',
      });
      const [query, setQuery] = React.useState('');
      const [statusFilter, setStatusFilter] = React.useState('');
      const [editing, setEditing] = React.useState(null);
      const [importing, setImporting] = React.useState(false);
      const [exporting, setExporting] = React.useState(false);
      const [selection, setSelection] = React.useState(null);
      const [probes, setProbes] = React.useState({});
      const [busy, setBusy] = React.useState({});
      const [prefsBusy, setPrefsBusy] = React.useState({});
      const [notice, setNotice] = React.useState(null);
      const [probeAll, setProbeAll] = React.useState({ busy: false, done: 0, total: 0, ok: 0 });
      const [autoProbeBusy, setAutoProbeBusy] = React.useState(false);
      const [viewMode, setViewMode] = React.useState(readStoredView);
      const [appFilter, setAppFilter] = React.useState('');
      const [collapsedApps, setCollapsedApps] = React.useState({});
      const [appBusy, setAppBusy] = React.useState('');
      const mounted = React.useRef(true);
      const autoProbeRan = React.useRef(false);
      const serversRef = React.useRef([]);

      React.useEffect(() => () => { mounted.current = false; }, []);

      const load = React.useCallback(async () => {
        try {
          const payload = await api.state();
          if (!mounted.current) return;
          const prefs = payload?.prefs ?? {};
          setState({
            phase: 'ready',
            servers: Array.isArray(payload?.servers) ? payload.servers : [],
            summary: payload?.summary ?? null,
            prefs: prefs !== null && typeof prefs === 'object' ? prefs : {},
            storePath: payload?.storePath,
            prefsPath: payload?.prefsPath,
            storeError: payload?.storeError,
            prefsError: payload?.prefsError,
            provisionFailures: payload?.provisionFailures ?? {},
            message: '',
          });
        } catch (error) {
          if (!mounted.current) return;
          setState((previous) => ({ ...previous, phase: 'error', message: String(error?.message ?? error) }));
        }
      }, []);

      React.useEffect(() => {
        load();
        const timer = setInterval(load, AUTO_REFRESH_MS);
        return () => clearInterval(timer);
      }, [load]);

      const servers = state.servers ?? [];
      serversRef.current = servers;

      const notify = React.useCallback((text, kind) => {
        const normalized = kind === 'error' || kind === 'warn' ? kind : 'ok';
        setNotice({ text: String(text ?? ''), kind: normalized });
      }, []);

      const toggleBusy = (id, value) => setBusy((previous) => ({ ...previous, [id]: value }));
      const togglePrefsBusy = (id, value) => setPrefsBusy((previous) => ({ ...previous, [id]: value }));

      const toggle = async (server) => {
        toggleBusy(server.id, true);
        try {
          await api.action('setEnabled', { server: server.id, enabled: !server.enabled });
          await load();
        } catch (error) {
          notify(format(t, 'toggleFailed', { message: String(error?.message ?? error) }), 'error');
        } finally {
          toggleBusy(server.id, false);
        }
      };

      const probe = async (server) => {
        toggleBusy(server.id, true);
        try {
          const result = await api.action('probe', { server: server.id });
          if (mounted.current) setProbes((previous) => ({ ...previous, [server.id]: result ?? {} }));
          // 探针会写入 prefs 历史：刷新一次让行内色点与成功率同步。
          await load();
        } catch (error) {
          if (mounted.current) {
            setProbes((previous) => ({
              ...previous,
              [server.id]: { ok: false, reachable: false, latencyMs: 0, error: String(error?.message ?? error) },
            }));
          }
        } finally {
          toggleBusy(server.id, false);
        }
      };

      const remove = async (server) => {
        toggleBusy(server.id, true);
        try {
          const result = await api.action('remove', { server: server.id });
          notify(result?.warning ?? format(t, 'notice.serverRemoved', { name: server.serverName }), result?.warning ? 'warn' : 'ok');
          await load();
        } catch (error) {
          notify(format(t, 'notice.removeFailed', { message: String(error?.message ?? error) }), 'error');
        } finally {
          toggleBusy(server.id, false);
        }
      };

      const patchPrefs = async (server, patch, errorKey) => {
        togglePrefsBusy(server.id, true);
        try {
          await api.action('patchPrefs', { server: server.id, patch });
          await load();
        } catch (error) {
          notify(format(t, errorKey, { message: String(error?.message ?? error) }), 'error');
        } finally {
          togglePrefsBusy(server.id, false);
        }
      };

      const runProbeAll = React.useCallback(async () => {
        const enabledCount = (serversRef.current ?? []).filter((server) => server.enabled).length;
        setProbeAll({ busy: true, done: 0, total: enabledCount, ok: 0 });
        try {
          const result = await api.action('probeMany', { includeDisabled: false });
          const results = Array.isArray(result?.results) ? result.results : [];
          const total = Number.isFinite(Number(result?.total)) ? Number(result.total) : results.length;
          const ok = Number.isFinite(Number(result?.ok)) ? Number(result.ok) : results.filter((item) => item?.ok === true).length;
          if (mounted.current) {
            setProbes((previous) => {
              const next = { ...previous };
              for (const item of results) {
                if (item && typeof item.serverName === 'string') next[`name:${item.serverName}`] = item;
              }
              return next;
            });
            setProbeAll({ busy: false, done: total, total, ok });
          }
          await load();
        } catch (error) {
          if (mounted.current) setProbeAll({ busy: false, done: 0, total: enabledCount, ok: 0 });
          notify(format(t, 'health.probeAllFailed', { message: String(error?.message ?? error) }), 'error');
        }
      }, [load, notify, t]);

      const setAutoProbe = async (next) => {
        setAutoProbeBusy(true);
        try {
          await api.action('setUiPrefs', { patch: { autoProbe: next === true } });
          await load();
        } catch (error) {
          notify(format(t, 'health.autoProbeFailed', { message: String(error?.message ?? error) }), 'error');
        } finally {
          setAutoProbeBusy(false);
        }
      };

      const changeView = (mode) => {
        const next = mode === 'flat' ? 'flat' : 'apps';
        setViewMode(next);
        storeView(next);
      };

      const renameApp = async (app, name) => {
        if (app === null || typeof app !== 'object' || typeof app.id !== 'string') return;
        const trimmed = typeof name === 'string' ? name.trim().slice(0, APP_NAME_LIMIT) : '';
        setAppBusy(app.id);
        try {
          await api.action('renameApp', { app: app.id, name: trimmed === '' ? null : trimmed });
          await load();
          notify(trimmed === '' ? t('apps.restored') : format(t, 'apps.renamed', { name: trimmed }), 'ok');
        } catch (error) {
          notify(format(t, 'apps.renameFailed', { message: String(error?.message ?? error) }), 'error');
        } finally {
          setAppBusy('');
        }
      };

      const autoProbeOn = state.prefs?.ui?.autoProbe === true;

      React.useEffect(() => {
        if (autoProbeRan.current) return;
        if (state.phase !== 'ready') return;
        if (autoProbeOn !== true) return;
        autoProbeRan.current = true;
        runProbeAll();
      }, [state.phase, autoProbeOn]);

      const prefsServers = prefsServersOf(state);
      const pinnedOf = (server) => isPinned(server, prefsServers[server.serverName]);
      const sorted = [...servers].sort((left, right) => compareServers(left, right, pinnedOf));
      const apps = appsOf(state);
      const multiApps = apps.filter((app) => (Number.isFinite(Number(app.total)) ? Number(app.total) : 0) >= 2);
      // 应用被重命名/恢复后 id 会变：旧筛选值自动失效，避免视图突然空白。
      const activeAppFilter = appFilter !== '' && apps.some((app) => app.id === appFilter) ? appFilter : '';
      const filtered = sorted.filter((server) => {
        if (statusFilter !== '' && server.status !== statusFilter) return false;
        if (activeAppFilter !== '' && appOfServer(server).id !== activeAppFilter) return false;
        if (query.trim() === '') return true;
        const needle = query.trim().toLowerCase();
        return String(server.serverName ?? '').toLowerCase().includes(needle)
          || String(server.id ?? '').toLowerCase().includes(needle)
          || String(server.shortId ?? '').toLowerCase().includes(needle)
          || String(server.transport ?? '').toLowerCase().includes(needle)
          || String(server.endpoint ?? '').toLowerCase().includes(needle)
          || String(appOfServer(server).name ?? '').toLowerCase().includes(needle)
          || toolNamesOf(server).some((toolName) => String(toolName).toLowerCase().includes(needle));
      });

      // 按「可见服务」分组：组排序沿用 state.apps 的顺序（找不到的排最后）。
      const visibleByApp = new Map();
      for (const server of filtered) {
        const app = appOfServer(server);
        const list = visibleByApp.get(app.id) ?? [];
        list.push(server);
        visibleByApp.set(app.id, list);
      }
      const appOrder = new Map(apps.map((app, index) => [app.id, index]));
      const orderedGroupIds = [...visibleByApp.keys()].sort((left, right) => {
        const leftIndex = appOrder.has(left) ? appOrder.get(left) : Number.MAX_SAFE_INTEGER;
        const rightIndex = appOrder.has(right) ? appOrder.get(right) : Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex || String(left).localeCompare(String(right));
      });
      const visibleGroups = orderedGroupIds.map((id) => ({
        app: apps.find((app) => app.id === id) ?? appOfServer(visibleByApp.get(id)[0]),
        servers: visibleByApp.get(id) ?? [],
      }));
      const cardGroups = visibleGroups.filter((group) => group.servers.length >= 2);
      const singletonRows = visibleGroups
        .filter((group) => group.servers.length === 1)
        .map((group) => ({ server: group.servers[0], app: group.app }));
      singletonRows.sort((left, right) => compareServers(left.server, right.server, pinnedOf));

      const startEdit = (server) => setEditing({
        mode: 'edit',
        server,
        manualApp: typeof prefsServers[server.serverName]?.app === 'string' ? prefsServers[server.serverName].app : '',
        detectedApp: String(server.app?.name ?? server.serverName ?? ''),
      });

      const rowHandlers = (server) => ({
        key: server.id,
        t,
        server,
        prefs: prefsServers[server.serverName] ?? {},
        pinned: typeof server.pinned === 'boolean' ? server.pinned : prefsServers[server.serverName]?.pinned === true,
        probeResult: probes[server.id] ?? probes[`name:${server.serverName}`],
        busy: busy[server.id] === true,
        prefsBusy: prefsBusy[server.id] === true,
        onToggle: () => toggle(server),
        onProbe: () => probe(server),
        onEdit: () => startEdit(server),
        onRemove: () => remove(server),
        onPin: (nextPinned) => patchPrefs(server, { pinned: nextPinned }, 'notice.pinFailed'),
        onTags: (tags) => patchPrefs(server, { tags }, 'notice.tagsFailed'),
        onNote: (note) => patchPrefs(server, { note }, 'notice.noteFailed'),
        onOpenTool: (tool) => setSelection(tool),
      });
      const renderServer = (server, appLabel) => h(ServerRow, {
        ...rowHandlers(server),
        ...(appLabel ? { appLabel } : {}),
      });

      const summary = state.summary;
      const statusCounts = Object.fromEntries(STATUS_KEYS.map((key) => [key, servers.filter((server) => server.status === key).length]));
      const rateText = probeRateText(t, prefsServers);

      const header = h('div', { style: styles.header },
        h('div', null,
          h('h3', { style: styles.title }, t('title')),
          h('p', { style: styles.subtitle }, t('subtitle'))),
        h('button', { type: 'button', style: styles.button, onClick: load }, t('refresh')));

      if (state.phase === 'loading') {
        return h('div', { style: styles.root }, header, h('p', { style: styles.hint }, t('loading')));
      }
      if (state.phase === 'error') {
        return h('div', { style: styles.root }, header,
          h('p', { style: styles.error }, `${t('errorApi')}（${state.message}）`));
      }

      const noticeStyle = notice?.kind === 'error'
        ? { ...styles.notice, color: 'var(--dsw-alias-state-error-primary, #d0563b)', border: '1px solid var(--dsw-alias-state-error-primary, #d0563b)' }
        : notice?.kind === 'warn'
          ? { ...styles.notice, color: 'var(--dsw-alias-status-warning, #d08b24)', border: '1px solid var(--dsw-alias-status-warning, #d08b24)' }
          : { ...styles.notice, color: 'var(--dsw-alias-status-success, #2f9e6e)', border: '1px solid var(--dsw-alias-border-l2)' };

      return h('div', { style: styles.root },
        header,
        notice ? h('p', { role: 'status', 'aria-live': 'polite', style: noticeStyle }, notice.text) : null,
        summary
          ? h('div', { style: styles.summary }, format(t, 'summary', {
            total: summary.total,
            unique: summary.uniqueServers,
            managed: summary.managed,
            enabled: summary.enabled,
            connected: summary.connected,
            disabled: summary.disabled,
            tools: summary.toolCount,
          }))
          : null,
        state.storeError ? h('p', { style: styles.error }, format(t, 'storeError', { message: state.storeError })) : null,
        state.prefsError ? h('p', { style: styles.error }, format(t, 'prefsError', { message: state.prefsError })) : null,
        Object.keys(state.provisionFailures ?? {}).length > 0
          ? h('div', null,
            h('p', { style: styles.error }, format(t, 'provisionFailures', { count: Object.keys(state.provisionFailures).length })),
            Object.entries(state.provisionFailures).map(([name, message]) => h('p', { key: name, style: styles.hint }, `- ${name}: ${message}`)))
          : null,
        h(HealthBar, {
          t,
          statusCounts,
          statusFilter,
          onStatusFilter: setStatusFilter,
          rateText,
          probeAll,
          onProbeAll: runProbeAll,
          autoProbe: autoProbeOn,
          autoProbeBusy,
          onToggleAutoProbe: () => setAutoProbe(!autoProbeOn),
        }),
        h('div', { style: styles.viewBar },
          h('span', { style: styles.label }, t('view.label')),
          h('button', {
            type: 'button',
            'aria-pressed': viewMode === 'apps',
            style: viewMode === 'apps' ? styles.primaryButton : styles.button,
            onClick: () => changeView('apps'),
          }, t('view.apps')),
          h('button', {
            type: 'button',
            'aria-pressed': viewMode === 'flat',
            style: viewMode === 'flat' ? styles.primaryButton : styles.button,
            onClick: () => changeView('flat'),
          }, t('view.flat')),
          multiApps.length > 0 ? h('span', { style: styles.label }, t('apps.filterLabel')) : null,
          multiApps.length > 0
            ? h('button', {
              type: 'button',
              'aria-pressed': activeAppFilter === '',
              style: activeAppFilter === '' ? styles.primaryButton : styles.button,
              onClick: () => setAppFilter(''),
            }, t('apps.filterAll'))
            : null,
          multiApps.map((app) => h('button', {
            key: app.id,
            type: 'button',
            'aria-pressed': activeAppFilter === app.id,
            style: activeAppFilter === app.id ? styles.primaryButton : styles.button,
            title: String(app.name ?? ''),
            onClick: () => setAppFilter((previous) => (previous === app.id ? '' : app.id)),
          }, `${app.icon ? `${app.icon} ` : ''}${String(app.name ?? '')} ${Number.isFinite(Number(app.total)) ? Number(app.total) : 0}`))),
        h('div', { style: styles.toolbar },
          h('input', {
            style: { ...styles.input, flex: '1 1 180px' },
            value: query,
            placeholder: t('searchPlaceholder'),
            'aria-label': t('searchPlaceholder'),
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', { type: 'button', style: styles.primaryButton, onClick: () => setEditing({ mode: 'add' }) }, t('add')),
          h('button', { type: 'button', style: styles.primaryButton, onClick: () => setImporting(true) }, t('import')),
          h('button', { type: 'button', style: styles.button, onClick: () => setExporting(true) }, t('export'))),

        editing
          ? h(EditPanel, {
            t,
            mode: editing.mode,
            server: editing.server,
            manualApp: editing.manualApp,
            detectedApp: editing.detectedApp,
            onClose: () => setEditing(null),
            onSaved: (message, kind) => { notify(message, kind ?? 'ok'); load(); },
          })
          : null,
        importing
          ? h(ImportPanel, {
            t,
            onClose: () => setImporting(false),
            onImported: (message) => { notify(message, 'ok'); load(); },
          })
          : null,
        exporting
          ? h(ExportPanel, { t, onClose: () => setExporting(false) })
          : null,

        h(ToolCenter, {
          t,
          onOpenTool: (tool) => setSelection(tool),
        }),

        servers.length === 0 || filtered.length === 0
          ? h('p', { style: styles.hint }, viewMode === 'apps' ? t('apps.empty') : t('empty'))
          : viewMode === 'flat'
            ? h('div', { style: styles.table, role: 'table', 'aria-label': t('title') },
              h('div', {
                style: { ...styles.rowMain, ...styles.summary, borderBottom: '1px solid var(--dsw-alias-border-l2)' },
                role: 'row',
              },
              h('span', { role: 'columnheader' }, t('column.server')),
              h('span', { role: 'columnheader' }, t('column.status')),
              h('span', { role: 'columnheader' }, t('column.transport')),
              h('span', { role: 'columnheader' }, t('column.tools')),
              h('span', { role: 'columnheader' }, t('column.actions'))),
              filtered.map((server) => renderServer(server)))
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
              cardGroups.map((group) => h(AppGroupCard, {
                key: group.app.id,
                t,
                app: group.app,
                servers: group.servers,
                collapsed: collapsedApps[group.app.id] === true,
                onToggle: () => setCollapsedApps((previous) => ({ ...previous, [group.app.id]: !previous[group.app.id] })),
                renderServer: (server) => renderServer(server),
                onRename: (name) => renameApp(group.app, name),
                onRestore: () => renameApp(group.app, null),
                busy: appBusy === group.app.id,
              })),
              singletonRows.length > 0
                ? h('div', { style: styles.groupCard },
                  h('h4', { style: styles.panelTitle, title: t('apps.independent') }, t('apps.independent')),
                  h('div', { style: styles.table, role: 'table', 'aria-label': t('apps.independent') },
                    singletonRows.map((item) => renderServer(item.server, `${item.app.icon ? `${item.app.icon} ` : ''}${String(item.app.name ?? '')}`))))
                : null),

        state.storePath ? h('div', { style: styles.summary }, format(t, 'storePath', { path: state.storePath })) : null,
        state.prefsPath ? h('div', { style: styles.summary }, format(t, 'prefsPath', { path: state.prefsPath })) : null,
        h('div', { style: styles.summary }, t('runtimeOnly')),

        selection
          ? h(ToolDrawer, {
            t,
            selection,
            onClose: () => setSelection(null),
          })
          : null);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const flatZh = flattenDictionary(zh);
        const flatEn = flattenDictionary(en);
        ctx.effect(() => ctx.locale.register(NS, { zh: flatZh, en: flatEn }), 'dsh-mcp-manager: dictionaries');
        const t = ctx.locale.bind(NS);
        const Section = (props) => h(McpManagerSection, { ...props, t: props?.t ?? t });
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'mcp-manager',
          order: 20,
          label: () => t('nav.label'),
          locale: NS,
        }, Section));
      },
    };
  },
});
