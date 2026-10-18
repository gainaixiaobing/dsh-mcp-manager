/**
 * dsh-mcp-manager —— Web UI 半区。
 *
 * 在 Harness 设置页新增一个「MCP 服务管理器」分区：列出本机已接入的 MCP 服务，
 * 展示连接状态 / 传输方式 / 工具数量与工具清单，并提供启用、停用开关。
 *
 * 与 Host 半区的契约：Host 在同一个 webServer 上挂载
 *   GET  /mcp-manager/api/state           → { ok, servers[], summary }
 *   POST /mcp-manager/api/action {method} → { ok, result }
 * 同源、只走回环；本模块只 require('react')，不依赖其它前端包。
 *
 * 渲染目标：`settings.section` 槽位（Harness 设置页的分区列表）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mcp-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'mcp-manager';
    const API_STATE = '/mcp-manager/api/state';
    const API_ACTION = '/mcp-manager/api/action';

    const zh = {
      nav: { label: 'MCP 服务' },
      title: 'MCP 服务管理器',
      subtitle: '只管理本机已经接入的 MCP 服务：查看状态与工具、启用或停用。新增与持久化请在对话里用 mcp_manager_add / mcp_manager_export。',
      refresh: '刷新',
      loading: '读取中…',
      empty: '当前 profile 还没有接入任何 MCP 服务。',
      errorApi: '管理 API 不可用，请确认 dsh-mcp-manager 插件已启用且 webApi 为 true。',
      column: { server: '服务', status: '状态', transport: '传输', tools: '工具' },
      status: { connected: '已连接', disabled: '已停用', 'no-tools': '无工具', failed: '加载失败' },
      toolCount: '{count} 个',
      duplicate: '同名',
      duplicateHint: '该服务被多个条目重复声明（profile 静态行 + 插件动态行），共享同一工具命名空间；启停请以条目 id 区分。',
      noTools: '没有已注册的工具（可能连接失败或服务本身不提供工具）',
      toggleOn: '启用',
      toggleOff: '停用',
      summary: '{total} 个服务 · {enabled} 个启用 · {connected} 个已连接 · {tools} 个工具',
      runtimeOnly: '启停只对本次运行生效；重启 Harness 后恢复 profile 配置。',
      showTools: '查看工具',
      hideTools: '收起工具',
      toggleFailed: '操作失败：{message}',
    };

    const en = {
      nav: { label: 'MCP servers' },
      title: 'MCP server manager',
      subtitle: 'Manage the MCP servers this machine already has: inspect status and tools, enable or disable. Use mcp_manager_add / mcp_manager_export in chat to add servers or persist changes.',
      refresh: 'Refresh',
      loading: 'Loading…',
      empty: 'No MCP server is connected in this profile yet.',
      errorApi: 'Management API unavailable. Check that dsh-mcp-manager is enabled and webApi is true.',
      column: { server: 'Server', status: 'Status', transport: 'Transport', tools: 'Tools' },
      status: { connected: 'Connected', disabled: 'Disabled', 'no-tools': 'No tools', failed: 'Failed to load' },
      toolCount: '{count}',
      duplicate: 'duplicate',
      duplicateHint: 'This server is declared by more than one loader entry (profile row + plugin row) and shares one tool namespace; use the entry id to tell them apart.',
      noTools: 'No tool is registered (the server may have failed to connect or expose none)',
      toggleOn: 'Enable',
      toggleOff: 'Disable',
      summary: '{total} servers · {enabled} enabled · {connected} connected · {tools} tools',
      runtimeOnly: 'Enabling or disabling only affects this run; a restart restores the profile configuration.',
      showTools: 'Show tools',
      hideTools: 'Hide tools',
      toggleFailed: 'Action failed: {message}',
    };

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary)', fontSize: '14px', lineHeight: '22px' },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' },
      title: { margin: 0, fontSize: '16px', fontWeight: 600 },
      subtitle: { margin: '6px 0 0', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      button: {
        appearance: 'none', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
        color: 'inherit', borderRadius: '8px', padding: '5px 12px', fontSize: '13px', cursor: 'pointer', font: 'inherit',
      },
      summary: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      table: { display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--dsw-alias-border-l2)' },
      row: { borderBottom: '1px solid var(--dsw-alias-border-l2)' },
      rowMain: { display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) 92px 104px 96px 132px', alignItems: 'center', gap: '12px', padding: '11px 2px' },
      serverName: { fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      endpoint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px' },
      dot: { width: '8px', height: '8px', borderRadius: '50%', flex: 'none' },
      toolsCell: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' },
      link: { appearance: 'none', border: 0, background: 'transparent', padding: 0, fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' },
      toolList: { display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '0 2px 12px' },
      toolChip: { fontSize: '12px', padding: '2px 8px', borderRadius: '999px', background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.12))', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      dupTag: { fontSize: '11px', padding: '0 6px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)', marginLeft: '6px', flex: 'none' },
      error: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)', padding: '10px 0' },
      switchWrap: { display: 'flex', justifyContent: 'flex-end' },
      switchButton: {
        appearance: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '999px',
        width: '42px', height: '24px', padding: 0, cursor: 'pointer', position: 'relative', background: 'transparent', transition: 'background .15s ease',
      },
      knob: { position: 'absolute', top: '2px', width: '18px', height: '18px', borderRadius: '50%', background: 'var(--dsw-alias-label-secondary)', transition: 'left .15s ease, background .15s ease' },
    };

    const STATUS_COLORS = {
      connected: 'var(--dsw-alias-status-success, #2f9e6e)',
      disabled: 'var(--dsw-alias-label-secondary, #8a8a8a)',
      'no-tools': 'var(--dsw-alias-status-warning, #d08b24)',
      failed: 'var(--dsw-alias-state-error-primary, #d0563b)',
    };

    function format(t, key, values) {
      const template = t(key);
      if (typeof template !== 'string') return key;
      return Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
        template,
      );
    }

    function StatusBadge({ t, status }) {
      const color = STATUS_COLORS[status] ?? STATUS_COLORS.disabled;
      return h('span', { style: styles.badge },
        h('span', { style: { ...styles.dot, background: color } }),
        h('span', null, t(`status.${status}`)));
    }

    function Switch({ t, enabled, busy, onToggle }) {
      return h('div', { style: styles.switchWrap },
        h('button', {
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
        }, h('span', { style: { ...styles.knob, left: enabled ? '21px' : '3px', background: enabled ? '#fff' : 'var(--dsw-alias-label-secondary)' } })));
    }

    function ServerRow({ t, server, onToggle }) {
      const [expanded, setExpanded] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const tools = Array.isArray(server.tools) ? server.tools : [];
      const toggle = React.useCallback(async () => {
        setBusy(true);
        try {
          await onToggle(server.serverName, !server.enabled);
        } finally {
          setBusy(false);
        }
      }, [server.serverName, server.enabled, onToggle]);
      return h('div', { style: styles.row },
        h('div', { style: styles.rowMain },
          h('div', null,
            h('div', { style: styles.serverName, title: server.id ?? server.serverName },
              server.serverName,
              server.duplicate
                ? h('span', { style: styles.dupTag, title: t('duplicateHint') }, t('duplicate'))
                : null),
            server.endpoint ? h('div', { style: styles.endpoint, title: server.endpoint }, server.endpoint) : null),
          h(StatusBadge, { t, status: server.status }),
          h('span', { style: { fontSize: '13px' } }, server.transport),
          h('div', { style: styles.toolsCell },
            h('span', null, format(t, 'toolCount', { count: server.toolCount })),
            tools.length > 0
              ? h('button', {
                type: 'button',
                style: styles.link,
                onClick: () => setExpanded((value) => !value),
              }, expanded ? t('hideTools') : t('showTools'))
              : null),
          h(Switch, { t, enabled: server.enabled, busy, onToggle: toggle })),
        expanded
          ? h('div', { style: styles.toolList },
            tools.length > 0
              ? tools.map((tool) => h('span', { key: tool, style: styles.toolChip }, tool))
              : h('span', { style: styles.error }, t('noTools')))
          : null);
    }

    function McpManagerSection({ t }) {
      const [state, setState] = React.useState({ phase: 'loading', servers: [], summary: null, message: '' });

      const mounted = React.useRef(true);
      React.useEffect(() => () => {
        mounted.current = false;
      }, []);

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(API_STATE, { headers: { accept: 'application/json' }, cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          if (!payload?.ok) throw new Error(payload?.message ?? 'unknown error');
          if (!mounted.current) return;
          setState({ phase: 'ready', servers: payload.servers ?? [], summary: payload.summary ?? null, message: '' });
        } catch (error) {
          if (!mounted.current) return;
          setState((previous) => ({ ...previous, phase: 'error', message: String(error?.message ?? error) }));
        }
      }, []);

      React.useEffect(() => {
        load();
      }, [load]);

      const toggle = React.useCallback(async (server, enabled) => {
        try {
          const response = await fetch(API_ACTION, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method: 'setEnabled', params: { server, enabled } }),
          });
          const payload = await response.json();
          if (!response.ok || !payload?.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
        } catch (error) {
          setState((previous) => ({ ...previous, message: format(t, 'toggleFailed', { message: String(error?.message ?? error) }) }));
        } finally {
          await load();
        }
      }, [load, t]);

      const summary = state.summary;
      const header = h('div', { style: styles.header },
        h('div', null,
          h('h3', { style: styles.title }, t('title')),
          h('p', { style: styles.subtitle }, t('subtitle'))),
        h('button', { type: 'button', style: styles.button, onClick: load }, t('refresh')));

      if (state.phase === 'loading') {
        return h('div', { style: styles.root }, header, h('div', { style: styles.error }, t('loading')));
      }
      if (state.phase === 'error') {
        return h('div', { style: styles.root }, header,
          h('div', { style: styles.error }, `${t('errorApi')}（${state.message}）`));
      }
      return h('div', { style: styles.root },
        header,
        summary
          ? h('div', { style: styles.summary }, format(t, 'summary', {
            total: summary.total,
            enabled: summary.enabled,
            connected: summary.connected,
            tools: summary.toolCount,
          }))
          : null,
        state.servers.length === 0
          ? h('div', { style: styles.error }, t('empty'))
          : h('div', { style: styles.table },
            h('div', { style: { ...styles.rowMain, ...styles.summary, borderBottom: '1px solid var(--dsw-alias-border-l2)' } },
              h('span', null, t('column.server')),
              h('span', null, t('column.status')),
              h('span', null, t('column.transport')),
              h('span', null, t('column.tools')),
              h('span', null, '')),
            state.servers.map((server) => h(ServerRow, {
              key: server.id ?? server.serverName,
              t,
              server,
              onToggle: toggle,
            }))),
        h('div', { style: { ...styles.summary, marginTop: '2px' } }, t('runtimeOnly')),
        state.message ? h('div', { style: styles.error }, state.message) : null);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mcp-manager: dictionaries');
        const t = ctx.locale.bind(NS);
        // 槽位组件可能拿不到 t（取决于宿主版本），用闭包里的 t 兜底。
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
