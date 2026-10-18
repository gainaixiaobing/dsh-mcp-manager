/**
 * dsh-mcp-manager —— Web UI 半区。
 *
 * 在 Harness 设置页新增「MCP 服务」分区：
 *   - 列表：来源（profile / 受管）、状态、传输、端点、工具数、工具展开；
 *   - 操作：启停开关、握手探针（延迟/工具数/错误）、编辑、删除；
 *   - 新增：表单接入 streamable-http / stdio；
 *   - 导入：粘贴 mcpServers JSON，或扫描本机 Claude Desktop / Cursor / VS Code 等配置；
 *   - 导出：cordis.patch.yml 片段 / 通用 mcpServers JSON / Markdown 清单。
 *
 * 与 Host 半区的契约：
 *   GET  /mcp-manager/api/state           → { ok, servers[], summary, storePath, ... }
 *   POST /mcp-manager/api/action {method} → { ok, result }
 * 只 require('react')，其它依赖全部来自宿主主题变量。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mcp-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'mcp-manager';
    const API_STATE = '/mcp-manager/api/state';
    const API_ACTION = '/mcp-manager/api/action';
    const AUTO_REFRESH_MS = 15000;

    const STATUS_KEYS = ['connected', 'disabled', 'no-tools', 'failed', 'not-provisioned'];

    const zh = {
      nav: { label: 'MCP 服务' },
      title: 'MCP 服务管理器',
      subtitle: '管理本机 MCP 服务：启停、探针、编辑、导入导出。受管连接会持久化到 profile 作用域的存储文件。',
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
      storeError: '受管存储读取失败：{message}',
      provisionFailures: '有 {count} 条受管记录未生效：',
      toggleFailed: '操作失败：{message}',
      probeOk: '{latency}ms · {count} 个工具',
      copyDiagnostics: '复制诊断',
      probeFailed: '探测失败：{message}',
      // 新增/编辑表单
      form: {
        addTitle: '接入新的 MCP 服务',
        editTitle: '编辑 MCP 服务：{name}',
        serverName: '服务名（工具命名空间）',
        serverNameHint: '1-32 位字母/数字/下划线/连字符；会成为 mcp__<serverName>__<tool>。',
        transport: '传输方式',
        url: 'MCP 端点 URL',
        headers: '请求头 JSON（可选；留空保持现有）',
        headersHint: '例如 {"Authorization": "Bearer ..."}；凭据只写入受管存储，不会回显。',
        command: '可执行文件',
        args: '参数 JSON 数组（可选）',
        env: '环境变量 JSON（可选；留空保持现有）',
        envHint: '例如 {"API_KEY": "..."}；凭据只写入受管存储，不会回显。',
        cwd: '工作目录（可选）',
        timeout: '工具调用超时（毫秒）',
        enabled: '保存后立即启用',
        existingSecrets: '已有凭据字段：{keys}（留空表示保持不变）',
        clearHeaders: '清空现有请求头',
        clearEnv: '清空现有环境变量',
        noExistingSecrets: '当前没有凭据字段',
        invalidJson: 'JSON 解析失败：{message}',
        saveFailed: '保存失败：{message}',
      },
      // 导入
      importer: {
        title: '导入 MCP 配置',
        pasteLabel: '粘贴 mcpServers JSON',
        pasteHint: '支持 {"mcpServers": {...}}、{"servers": {...}}、直接映射或数组。',
        scan: '扫描本机配置',
        scanning: '扫描中…',
        noScan: '还没有扫描结果',
        sources: '发现 {count} 个配置文件',
        candidates: '可导入条目',
        selected: '已选 {count} 个',
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
        errors: '失败/跳过：',
      },
      // 导出
      exporter: {
        title: '导出配置',
        patch: 'patch（cordis.patch.yml）',
        json: 'mcpServers JSON',
        markdown: 'Markdown 清单',
        download: '下载文件',
        copy: '复制',
        copied: '已复制',
        warnings: '提示：',
      },
    };

    const en = {
      nav: { label: 'MCP servers' },
      title: 'MCP server manager',
      subtitle: 'Manage local MCP servers: enable/disable, probe, edit, import and export. Managed connections persist to a profile-scoped store.',
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
      storeError: 'Managed store failed to load: {message}',
      provisionFailures: '{count} managed record(s) not provisioned:',
      toggleFailed: 'Action failed: {message}',
      probeOk: '{latency}ms · {count} tools',
      copyDiagnostics: 'Copy diagnostics',
      probeFailed: 'Probe failed: {message}',
      form: {
        addTitle: 'Add an MCP server',
        editTitle: 'Edit MCP server: {name}',
        serverName: 'Server name (tool namespace)',
        serverNameHint: '1-32 letters/digits/_/-; becomes mcp__<serverName>__<tool>.',
        transport: 'Transport',
        url: 'MCP endpoint URL',
        headers: 'Headers JSON (optional; leave empty to keep current)',
        headersHint: 'e.g. {"Authorization": "Bearer ..."}; credentials only go to the managed store and are never echoed back.',
        command: 'Command',
        args: 'Args JSON array (optional)',
        env: 'Env JSON (optional; leave empty to keep current)',
        envHint: 'e.g. {"API_KEY": "..."}; credentials only go to the managed store and are never echoed back.',
        cwd: 'Working directory (optional)',
        timeout: 'Tool call timeout (ms)',
        enabled: 'Enable after save',
        existingSecrets: 'Existing credential fields: {keys} (leave empty to keep)',
        clearHeaders: 'Clear current headers',
        clearEnv: 'Clear current env',
        noExistingSecrets: 'No credential fields yet',
        invalidJson: 'Invalid JSON: {message}',
        saveFailed: 'Save failed: {message}',
      },
      importer: {
        title: 'Import MCP configuration',
        pasteLabel: 'Paste mcpServers JSON',
        pasteHint: 'Supports {"mcpServers": {...}}, {"servers": {...}}, a raw map or an array.',
        scan: 'Scan local clients',
        scanning: 'Scanning…',
        noScan: 'No scan result yet',
        sources: '{count} config file(s) found',
        candidates: 'Importable entries',
        selected: '{count} selected',
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
        errors: 'Failed / skipped:',
      },
      exporter: {
        title: 'Export configuration',
        patch: 'patch (cordis.patch.yml)',
        json: 'mcpServers JSON',
        markdown: 'Markdown inventory',
        download: 'Download',
        copy: 'Copy',
        copied: 'Copied',
        warnings: 'Notes:',
      },
    };

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)', fontSize: '14px', lineHeight: '22px' },
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
      table: { display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--dsw-alias-border-l2)' },
      row: { borderBottom: '1px solid var(--dsw-alias-border-l2)' },
      rowMain: { display: 'grid', gridTemplateColumns: 'minmax(150px, 1fr) 86px 96px 90px 168px', alignItems: 'center', gap: '10px', padding: '10px 2px' },
      serverName: { fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      endpoint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', whiteSpace: 'nowrap' },
      dot: { width: '8px', height: '8px', borderRadius: '50%', flex: 'none' },
      tag: { fontSize: '11px', padding: '0 6px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)', marginLeft: '6px', flex: 'none' },
      link: { appearance: 'none', border: 0, background: 'transparent', padding: 0, fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' },
      toolList: { display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '0 2px 10px' },
      toolChip: { fontSize: '12px', padding: '2px 8px', borderRadius: '999px', background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.12))', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
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
    };

    const STATUS_COLORS = {
      connected: 'var(--dsw-alias-status-success, #2f9e6e)',
      disabled: 'var(--dsw-alias-label-secondary, #8a8a8a)',
      'no-tools': 'var(--dsw-alias-status-warning, #d08b24)',
      failed: 'var(--dsw-alias-state-error-primary, #d0563b)',
      'not-provisioned': 'var(--dsw-alias-status-warning, #d08b24)',
    };

    function format(t, key, values) {
      const template = t(key);
      if (typeof template !== 'string') return key;
      return Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
        template,
      );
    }

    async function copyDiagnostics(result) {
      const lines = [
        result?.error ?? '',
        result?.exitCode !== undefined ? `exitCode=${result.exitCode}` : '',
        result?.stderr ?? '',
      ].filter(Boolean);
      try {
        await navigator.clipboard.writeText(lines.join('\n'));
      } catch {
        /* 剪贴板不可用时忽略 */
      }
    }

    async function request(url, options) {
      const response = await fetch(url, {
        cache: 'no-store',
        headers: { accept: 'application/json', ...(options?.body ? { 'content-type': 'application/json' } : {}) },
        ...options,
      });
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

    function Switch({ t, enabled, busy, onToggle }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': enabled,
        'aria-label': enabled ? t('toggleOff') : t('toggleOn'),
        title: enabled ? t('toggleOff') : t('toggleOn'),
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
      };
    }

    function formFromConfig(config) {
      if (!config) return emptyForm();
      return {
        serverName: config.serverName,
        transport: config.transport === 'stdio' ? 'stdio' : 'streamable-http',
        url: config.url ?? '',
        headers: '',
        command: config.command ?? '',
        args: JSON.stringify(config.args ?? [], null, 2),
        env: '',
        cwd: config.cwd ?? '',
        timeout: String(config.toolCallTimeoutMs ?? 180000),
        enabled: config.enabled !== false,
      };
    }

    function parseJsonField(t, label, text) {
      const trimmed = String(text ?? '').trim();
      if (trimmed === '') return undefined;
      try {
        return JSON.parse(trimmed);
      } catch (error) {
        throw new Error(format(t, 'form.invalidJson', { message: `${label}: ${error.message}` }));
      }
    }

    function EditPanel({ t, mode, server, onClose, onSaved, onError }) {
      const [form, setForm] = React.useState(emptyForm);
      const [config, setConfig] = React.useState(undefined);
      const [clear, setClear] = React.useState({ headers: false, env: false });
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');

      React.useEffect(() => {
        if (mode !== 'edit' || !server) return;
        let active = true;
        api.action('config', { server: server.serverName })
          .then((result) => {
            if (!active) return;
            setConfig(result);
            setForm(formFromConfig(result));
          })
          .catch((failure) => active && setError(String(failure?.message ?? failure)));
        return () => { active = false; };
      }, [mode, server?.serverName]);

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
          const timeout = parseJsonField(t, t('form.timeout'), String(form.timeout || '180000'));
          if (isAdd) {
            const params = {
              serverName: form.serverName.trim(),
              transport,
              enabled: form.enabled !== false,
              persist: true,
            };
            if (timeout !== undefined) params.toolCallTimeoutMs = Number(form.timeout);
            if (transport === 'streamable-http') {
              params.url = form.url.trim();
              const headers = parseJsonField(t, t('form.headers'), form.headers);
              if (headers !== undefined) params.headers = headers;
            } else {
              params.command = form.command.trim();
              const args = parseJsonField(t, t('form.args'), form.args);
              if (args !== undefined) params.args = args.map(String);
              const env = parseJsonField(t, t('form.env'), form.env);
              if (env !== undefined) params.env = env;
              if (form.cwd.trim() !== '') params.cwd = form.cwd.trim();
            }
            await api.action('add', params);
          } else {
            const changes = {};
            if (timeout !== undefined) changes.toolCallTimeoutMs = Number(form.timeout);
            if (transport === 'streamable-http') {
              if (form.url.trim() !== '') changes.url = form.url.trim();
              const headers = parseJsonField(t, t('form.headers'), form.headers);
              if (headers !== undefined) changes.headers = headers;
            } else {
              if (form.command.trim() !== '') changes.command = form.command.trim();
              const args = parseJsonField(t, t('form.args'), form.args);
              if (args !== undefined) changes.args = args.map(String);
              const env = parseJsonField(t, t('form.env'), form.env);
              if (env !== undefined) changes.env = env;
              if (form.cwd.trim() !== '') changes.cwd = form.cwd.trim();
            }
            if (clear.headers) changes.deleteHeaders = true;
            if (clear.env) changes.deleteEnv = true;
            await api.action('update', { server: server.serverName, changes });
          }
          onSaved(isAdd ? '已接入' : '已更新');
          onClose();
        } catch (failure) {
          setError(format(t, 'form.saveFailed', { message: String(failure?.message ?? failure) }));
        } finally {
          setBusy(false);
        }
      };

      const isHttp = form.transport === 'streamable-http';
      const secretKeys = config ? (isHttp ? config.headerKeys : config.envKeys) : [];
      const secretHint = secretKeys?.length
        ? format(t, 'form.existingSecrets', { keys: secretKeys.join('、') })
        : t('form.noExistingSecrets');

      return h('div', { style: styles.panel },
        h('h4', { style: styles.panelTitle }, mode === 'add'
          ? t('form.addTitle')
          : format(t, 'form.editTitle', { name: server?.serverName ?? '' })),
        h('div', { style: styles.fieldRow },
          mode === 'add'
            ? h(Field, { label: t('form.serverName'), hint: t('form.serverNameHint') },
              h('input', { style: styles.input, value: form.serverName, onChange: update('serverName'), placeholder: 'my-server' }))
            : null,
          h(Field, { label: t('form.transport') },
            h('select', { style: styles.input, value: form.transport, onChange: update('transport'), disabled: mode === 'edit' },
              h('option', { value: 'streamable-http' }, 'streamable-http'),
              h('option', { value: 'stdio' }, 'stdio')))),
        isHttp
          ? h(Field, { label: t('form.url') },
            h('input', { style: styles.input, value: form.url, onChange: update('url'), placeholder: 'https://example.com/mcp' }))
          : h('div', null,
            h(Field, { label: t('form.command') },
              h('input', { style: styles.input, value: form.command, onChange: update('command'), placeholder: 'npx' })),
            h(Field, { label: t('form.cwd') },
              h('input', { style: styles.input, value: form.cwd, onChange: update('cwd'), placeholder: '/path/to/workdir' }))),
        h('div', { style: styles.fieldRow },
          h(Field, { label: t('form.timeout') },
            h('input', { style: styles.input, type: 'number', min: 1000, value: form.timeout, onChange: update('timeout') }))),
        isHttp
          ? h(Field, { label: t('form.headers'), hint: `${t('form.headersHint')} ${secretHint}` },
            h('textarea', { style: { ...styles.textarea, minHeight: '56px' }, value: form.headers, onChange: update('headers'), placeholder: '{"Authorization": "Bearer ..."}' }))
          : h('div', null,
            h(Field, { label: t('form.args') },
              h('textarea', { style: { ...styles.textarea, minHeight: '56px' }, value: form.args, onChange: update('args') })),
            h(Field, { label: t('form.env'), hint: `${t('form.envHint')} ${secretHint}` },
              h('textarea', { style: { ...styles.textarea, minHeight: '56px' }, value: form.env, onChange: update('env'), placeholder: '{"API_KEY": "..." }'}))),
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
        error ? h('p', { style: styles.error }, error) : null,
        h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
          h('button', { type: 'button', style: styles.button, onClick: onClose, disabled: busy }, t('cancel')),
          h('button', { type: 'button', style: styles.primaryButton, onClick: submit, disabled: busy }, busy ? t('saving') : t('save'))));
    }

    // ── 导入面板 ────────────────────────────────────────────────────────────

    function ImportPanel({ t, onClose, onImported, onError }) {
      const [json, setJson] = React.useState('');
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
          for (const candidate of result.candidates ?? []) next[`${candidate.file}\u0000${candidate.serverName}`] = candidate.conflict !== true;
          setSelected(next);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
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
            setMessage(format(t, 'importer.previewResult', { count: result.records?.length ?? 0 }));
            return;
          }
          const groups = groupByFile(scan, selected);
          if (groups.length === 0) throw new Error('请粘贴 JSON，或从扫描结果里勾选条目');
          const results = [];
          for (const group of groups) {
            const result = await api.action('import', { file: group.file, servers: group.servers, apply: false });
            results.push({ group, result });
          }
          setPreview({ kind: 'scan', results });
          const count = results.reduce((sum, item) => sum + (item.result.records?.length ?? 0), 0);
          setMessage(format(t, 'importer.previewResult', { count }));
        } catch (failure) {
          setError(String(failure?.message ?? failure));
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
            onImported(format(t, 'importer.result', { count: result.imported?.length ?? 0, failed: result.errors?.length ?? 0 }));
            onClose();
            return;
          }
          const groups = groupByFile(scan, selected);
          let imported = 0;
          let failed = 0;
          for (const group of groups) {
            const result = await api.action('import', { file: group.file, servers: group.servers, apply: true, onConflict: conflictAction, enabled: importEnabled });
            imported += result.imported?.length ?? 0;
            failed += result.errors?.length ?? 0;
          }
          onImported(format(t, 'importer.result', { count: imported, failed }));
          onClose();
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        } finally {
          setBusy(false);
        }
      };

      const candidates = scan?.candidates ?? [];
      const selectedCount = Object.values(selected).filter(Boolean).length;

      return h('div', { style: styles.panel },
        h('h4', { style: styles.panelTitle }, t('importer.title')),
        h(Field, { label: t('importer.pasteLabel'), hint: t('importer.pasteHint') },
          h('textarea', { style: { ...styles.textarea, minHeight: '90px' }, value: json, onChange: (event) => setJson(event.target.value), placeholder: '{"mcpServers": {"github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"]}}}' })),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('button', { type: 'button', style: styles.button, onClick: runScan, disabled: scanning || busy }, scanning ? t('importer.scanning') : t('importer.scan')),
          scan ? h('span', { style: styles.hint }, format(t, 'importer.sources', { count: scan.sources?.length ?? 0 })) : h('span', { style: styles.hint }, t('importer.noScan'))),
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
            h('div', { style: styles.label }, t('importer.selected').replace('{count}', '')),
            h('pre', { style: styles.code }, JSON.stringify(preview, null, 2).slice(0, 4000)))
          : null,
        message ? h('p', { style: styles.hint }, message) : null,
        error ? h('p', { style: styles.error }, error) : null,
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: styles.label }, t('importer.onConflict')),
          h('select', { style: styles.input, value: conflictAction, onChange: (event) => setConflictAction(event.target.value) },
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

    function ExportPanel({ t, onClose, onError }) {
      const [result, setResult] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false);
      const [copied, setCopied] = React.useState(false);
      const [error, setError] = React.useState('');

      const run = async (format) => {
        setBusy(true);
        setError('');
        try {
          const value = await api.action('export', { format });
          setResult(value);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
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
          const ext = result?.format === 'json' ? 'json' : result?.format === 'markdown' ? 'md' : 'yml';
          anchor.href = href;
          anchor.download = `mcp-manager-export.${ext}`;
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(href), 1000);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        }
      };

      const copy = async () => {
        try {
          await navigator.clipboard.writeText(result?.content ?? '');
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        }
      };

      return h('div', { style: styles.panel },
        h('h4', { style: styles.panelTitle }, t('exporter.title')),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { type: 'button', style: styles.button, onClick: () => run('patch'), disabled: busy }, t('exporter.patch')),
          h('button', { type: 'button', style: styles.button, onClick: () => run('json'), disabled: busy }, t('exporter.json')),
          h('button', { type: 'button', style: styles.button, onClick: () => run('markdown'), disabled: busy }, t('exporter.markdown'))),
        result
          ? h('div', null,
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
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

    // ── 服务行 ──────────────────────────────────────────────────────────────

    function ServerRow({ t, server, probeResult, busy, onToggle, onProbe, onEdit, onRemove }) {
      const [expanded, setExpanded] = React.useState(false);
      const [confirming, setConfirming] = React.useState(false);
      const tools = Array.isArray(server.toolNames) ? server.toolNames : [];
      const remote = probeResult?.serverNameRemote;

      return h('div', { style: styles.row },
        h('div', { style: styles.rowMain },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: styles.serverName, title: server.id },
              server.serverName,
              h(Tag, { title: t('origin.' + server.origin) }, t('origin.' + server.origin)),
              server.duplicate ? h(Tag, { title: t('duplicateHint') }, t('duplicate')) : null),
            server.endpoint ? h('div', { style: styles.endpoint, title: server.endpoint }, server.endpoint) : null,
            server.error ? h('div', { style: styles.error, title: server.error }, server.error) : null,
            probeResult
              ? h('div', null,
                h('div', { style: probeResult.reachable ? styles.hint : styles.error },
                  probeResult.reachable
                    ? format(t, 'probeOk', { latency: probeResult.latencyMs, count: probeResult.toolCount ?? 0 }) + (remote ? ` · ${remote}` : '')
                    : format(t, 'probeFailed', { message: probeResult.error ?? '' })),
                probeResult.reachable ? null : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' } },
                  probeResult.exitCode !== undefined ? h('div', { style: styles.hint }, `exitCode=${probeResult.exitCode}`) : null,
                  probeResult.stderr
                    ? h('div', null,
                      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                        h('span', { style: styles.hint }, 'stderr（已脱敏）'),
                        h('button', { type: 'button', style: styles.link, onClick: () => copyDiagnostics(probeResult) }, t('copyDiagnostics'))),
                      h('pre', { style: { ...styles.code, maxHeight: '140px' } }, probeResult.stderr))
                    : null))
              : null),
          h(Badge, { t, status: server.status }),
          h('span', { style: { fontSize: '12px' } }, server.transport),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' } },
            h('span', null, format(t, 'toolCount', { count: server.toolCount })),
            tools.length > 0
              ? h('button', { type: 'button', style: styles.link, onClick: () => setExpanded((value) => !value) },
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
            tools.length > 0
              ? tools.map((tool) => h('span', { key: tool, style: styles.toolChip }, tool))
              : h('span', { style: styles.hint }, t('noTools')))
          : null);
    }

    // ── 主面板 ──────────────────────────────────────────────────────────────

    function McpManagerSection({ t }) {
      const [state, setState] = React.useState({ phase: 'loading', servers: [], summary: null, message: '' });
      const [query, setQuery] = React.useState('');
      const [statusFilter, setStatusFilter] = React.useState('');
      const [editing, setEditing] = React.useState(null);
      const [importing, setImporting] = React.useState(false);
      const [exporting, setExporting] = React.useState(false);
      const [probes, setProbes] = React.useState({});
      const [busy, setBusy] = React.useState({});
      const mounted = React.useRef(true);
      React.useEffect(() => () => { mounted.current = false; }, []);

      const load = React.useCallback(async () => {
        try {
          const payload = await api.state();
          if (!mounted.current) return;
          setState({ phase: 'ready', servers: payload.servers ?? [], summary: payload.summary ?? null, storePath: payload.storePath, storeError: payload.storeError, provisionFailures: payload.provisionFailures ?? {}, message: '' });
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

      const notify = React.useCallback((message) => {
        setState((previous) => ({ ...previous, message }));
      }, []);

      const setServerBusy = (serverName, value) => setProbes((previous) => ({ ...previous, [serverName]: previous[serverName] }));
      const toggleBusy = (key, value) => setBusy((previous) => ({ ...previous, [key]: value }));

      const toggle = async (server) => {
        toggleBusy(server.serverName, true);
        try {
          await api.action('setEnabled', { server: server.serverName, enabled: !server.enabled });
        } catch (error) {
          notify(format(t, 'toggleFailed', { message: String(error?.message ?? error) }));
        } finally {
          toggleBusy(server.serverName, false);
          await load();
        }
      };

      const probe = async (server) => {
        toggleBusy(server.serverName, true);
        try {
          const result = await api.action('probe', { server: server.serverName });
          if (mounted.current) setProbes((previous) => ({ ...previous, [server.serverName]: result }));
        } catch (error) {
          if (mounted.current) setProbes((previous) => ({ ...previous, [server.serverName]: { reachable: false, error: String(error?.message ?? error), latencyMs: 0 } }));
        } finally {
          toggleBusy(server.serverName, false);
        }
      };

      const remove = async (server) => {
        toggleBusy(server.serverName, true);
        try {
          const result = await api.action('remove', { server: server.serverName });
          notify(result?.warning ?? `已移除 ${server.serverName}`);
        } catch (error) {
          notify(String(error?.message ?? error));
        } finally {
          toggleBusy(server.serverName, false);
          await load();
        }
      };

      const servers = state.servers ?? [];
      const visible = servers.filter((server) => {
        if (statusFilter !== '' && server.status !== statusFilter) return false;
        if (query.trim() === '') return true;
        const needle = query.trim().toLowerCase();
        return server.serverName.toLowerCase().includes(needle)
          || server.id.toLowerCase().includes(needle)
          || server.transport.toLowerCase().includes(needle)
          || String(server.endpoint ?? '').toLowerCase().includes(needle)
          || (server.toolNames ?? []).some((toolName) => String(toolName).toLowerCase().includes(needle));
      });
      const summary = state.summary;
      const statusCounts = Object.fromEntries(STATUS_KEYS.map((key) => [key, servers.filter((server) => server.status === key).length]));

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

      return h('div', { style: styles.root },
        header,
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
        h('div', { style: styles.toolbar },
          STATUS_KEYS.map((key) => h('button', {
            key,
            type: 'button',
            style: statusFilter === key ? { ...styles.primaryButton, borderColor: 'var(--dsw-alias-label-primary)' } : styles.button,
            onClick: () => setStatusFilter((value) => (value === key ? '' : key)),
          }, `${t(`status.${key}`)} ${statusCounts[key]}`))),
        state.storeError ? h('p', { style: styles.error }, format(t, 'storeError', { message: state.storeError })) : null,
        Object.keys(state.provisionFailures ?? {}).length > 0
          ? h('div', null,
            h('p', { style: styles.error }, format(t, 'provisionFailures', { count: Object.keys(state.provisionFailures).length })),
            Object.entries(state.provisionFailures).map(([name, message]) => h('p', { key: name, style: styles.hint }, `- ${name}: ${message}`)))
          : null,
        h('div', { style: styles.toolbar },
          h('input', { style: { ...styles.input, flex: '1 1 180px' }, value: query, placeholder: t('searchPlaceholder'), onChange: (event) => setQuery(event.target.value) }),
          h('select', { style: styles.input, value: statusFilter, onChange: (event) => setStatusFilter(event.target.value) },
            h('option', { value: '' }, t('allStatuses')),
            STATUS_KEYS.map((key) => h('option', { key, value: key }, t(`status.${key}`)))),
          h('button', { type: 'button', style: styles.primaryButton, onClick: () => setEditing({ mode: 'add' }) }, t('add')),
          h('button', { type: 'button', style: styles.primaryButton, onClick: () => setImporting(true) }, t('import')),
          h('button', { type: 'button', style: styles.button, onClick: () => setExporting(true) }, t('export'))),

        editing
          ? h(EditPanel, {
            t,
            mode: editing.mode,
            server: editing.server,
            onClose: () => setEditing(null),
            onSaved: (message) => { notify(message); load(); },
            onError: (message) => notify(message),
          })
          : null,
        importing ? h(ImportPanel, { t, onClose: () => setImporting(false), onImported: (message) => { notify(message); load(); }, onError: (message) => notify(message) }) : null,
        exporting ? h(ExportPanel, { t, onClose: () => setExporting(false), onError: (message) => notify(message) }) : null,

        servers.length === 0
          ? h('p', { style: styles.hint }, t('empty'))
          : h('div', { style: styles.table },
            h('div', { style: { ...styles.rowMain, ...styles.summary, borderBottom: '1px solid var(--dsw-alias-border-l2)' } },
              h('span', null, t('column.server')),
              h('span', null, t('column.status')),
              h('span', null, t('column.transport')),
              h('span', null, t('column.tools')),
              h('span', null, t('column.actions'))),
            visible.map((server) => h(ServerRow, {
              key: server.id,
              t,
              server,
              probeResult: probes[server.serverName],
              busy: busy[server.serverName] === true,
              onToggle: () => toggle(server),
              onProbe: () => probe(server),
              onEdit: () => setEditing({ mode: 'edit', server }),
              onRemove: () => remove(server),
            }))),

        state.storePath ? h('div', { style: styles.summary }, format(t, 'storePath', { path: state.storePath })) : null,
        h('div', { style: styles.summary }, t('runtimeOnly')),
        state.message ? h('p', { style: styles.error }, state.message) : null);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mcp-manager: dictionaries');
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
