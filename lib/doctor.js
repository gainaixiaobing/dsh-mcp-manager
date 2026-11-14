/**
 * 体检（doctor）：只读静态诊断，不发网络请求、不改配置。
 *
 * 借鉴 `pathintegral-institute/mcpm.sh` 的 `mcpm doctor`、`spences10/mcpick` 的
 * `mcpick_doctor`、`ravitemer/mcp-hub` 的占位符解析：把「看起来已接入、实际起不来」
 * 的常见原因提前找出来，而不是等握手失败再猜。
 *
 * 检查项：
 *   - 运行状态：加载失败 / 未生效 / 无工具；
 *   - 配置可启动性：stdio `command` 是否在 PATH、`cwd` 是否存在；
 *   - 占位符：`${VAR}` / `${env:VAR}` / `!!js process.env.VAR` 引用的变量是否已定义，
 *     `${input:...}` 这类交互式变量在本机无法解析；
 *   - 配置卫生：空的 env 值、URL/header/args 里的明文凭据（复用 inventory 的 riskFlags）；
 *   - 一致性与冗余：同名条目、重复端点、受管记录与运行时 enabled 漂移、孤儿工具；
 *   - 探针健康：最近一次探针失败、从未探测。
 *
 * 严重度：error（现在就是坏的）/ warn（有风险或不一致）/ info（提示，不影响使用）。
 */
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { endpointOf, isJsExpr, isPlainObject, truncate } from './util.js';
import { augmentedPath } from './path.js';

export const SEVERITIES = ['error', 'warn', 'info'];

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 };

/** `${VAR}` / `${env:VAR}` / `${VAR:-default}` / `${input:id}`。 */
const PLACEHOLDER_RE = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$\{input:([^}]+)\}/g;

/** `!!js` 表达式里的 `process.env.X` 引用。 */
const JS_ENV_RE = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * 从一段文本里找出占位符。
 *
 * @param {string} text - 待扫描文本。
 * @returns {Array<{raw:string, kind:'env'|'input', name:string, hasDefault:boolean}>} 占位符列表。
 */
export function findPlaceholders(text) {
  if (typeof text !== 'string' || !text.includes('${')) return [];
  const out = [];
  PLACEHOLDER_RE.lastIndex = 0;
  let match = PLACEHOLDER_RE.exec(text);
  while (match !== null) {
    if (match[3] !== undefined) {
      out.push({ raw: match[0], kind: 'input', name: match[3], hasDefault: false });
    } else {
      out.push({
        raw: match[0],
        kind: 'env',
        name: match[1],
        hasDefault: match[2] !== undefined,
      });
    }
    match = PLACEHOLDER_RE.exec(text);
  }
  return out;
}

/** 从 `!!js` 表达式里找出引用的环境变量名。 */
export function findJsEnvRefs(expr) {
  if (typeof expr !== 'string') return [];
  const names = [];
  JS_ENV_RE.lastIndex = 0;
  let match = JS_ENV_RE.exec(expr);
  while (match !== null) {
    if (!names.includes(match[1])) names.push(match[1]);
    match = JS_ENV_RE.exec(expr);
  }
  return names;
}

/** 把配置里所有「可能含占位符」的字符串摊平（带路径，便于报错定位）。 */
export function declaredStrings(config) {
  const out = [];
  if (!isPlainObject(config)) return out;
  const push = (path, value) => {
    if (typeof value === 'string') out.push({ path, value, jsExpr: undefined });
    else if (isJsExpr(value)) out.push({ path, value: '', jsExpr: String(value.__jsExpr ?? '') });
  };
  push('url', config.url);
  push('command', config.command);
  push('cwd', config.cwd);
  if (isPlainObject(config.headers)) {
    for (const [key, value] of Object.entries(config.headers)) push(`headers.${key}`, value);
  }
  if (isPlainObject(config.env)) {
    for (const [key, value] of Object.entries(config.env)) push(`env.${key}`, value);
  }
  if (Array.isArray(config.args)) {
    config.args.forEach((value, index) => push(`args[${index}]`, value));
  }
  return out;
}

/** 命令能否在本机解析（绝对/相对路径看文件，裸命令查 PATH）。 */
export function commandResolves(command, env = process.env) {
  if (typeof command !== 'string' || command.trim() === '') return false;
  const value = command.trim();
  if (value.includes('/') || value.includes('\\')) {
    try {
      accessSync(value, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathValue = typeof env?.PATH === 'string' ? env.PATH : '';
  for (const dir of pathValue.split(':')) {
    if (dir === '') continue;
    try {
      accessSync(join(dir, value), constants.X_OK);
      return true;
    } catch {
      /* 继续找下一个目录 */
    }
  }
  return false;
}

function directoryExists(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/** 声明的端点指纹：http 用 url，stdio 用 command + 完整 args（避免展示串误判）。 */
function endpointFingerprint(config) {
  if (!isPlainObject(config)) return '';
  if (config.url !== undefined) {
    return `url:${isJsExpr(config.url) ? `expr:${config.url.__jsExpr}` : String(config.url)}`;
  }
  const command = isJsExpr(config.command)
    ? `expr:${config.command.__jsExpr}`
    : (typeof config.command === 'string' ? config.command : '');
  if (command === '') return '';
  const args = Array.isArray(config.args)
    ? config.args.map((arg) => (isJsExpr(arg) ? `expr:${arg.__jsExpr}` : String(arg)))
    : [];
  return `cmd:${command}\u0000${args.join('\u0000')}`;
}

const RISK_LABEL = (flag) => {
  switch (flag) {
    case 'url-secret': return 'URL query 里带明文凭据';
    case 'header-secret': return '请求头里有明文凭据';
    case 'env-secret': return '环境变量里有明文凭据';
    case 'args-secret': return '命令行参数里有明文凭据';
    case 'shell-args': return 'args 里有 $()/反引号';
    default: return String(flag);
  }
};

/**
 * 生成体检报告。
 *
 * @param {object} input
 * @param {object[]} input.servers - `listServers().servers`。
 * @param {object} [input.summary] - `listServers().summary`。
 * @param {(server: object) => object} [input.declaredOf] - 取「声明态配置」（含未求值的 `!!js`）。
 * @param {Record<string, object>} [input.prefsServers] - 偏好文件里的服务元数据（含探针历史）。
 * @param {Record<string, string>} [input.provisionFailures] - 启动期 provision 失败原因。
 * @param {string} [input.storeError] - 受管存储读取错误。
 * @param {string} [input.prefsError] - 偏好存储读取错误。
 * @param {NodeJS.ProcessEnv} [input.env] - 变量解析环境（默认 process.env，便于测试注入）。
 * @param {number} [input.now] - 当前时间（毫秒，便于测试）。
 * @returns {{generatedAt:string, summary:object, findings:object[]}} 报告。
 */
export function buildDoctorReport(input = {}) {
  const started = Date.now();
  const servers = Array.isArray(input.servers) ? input.servers : [];
  const summaryIn = isPlainObject(input.summary) ? input.summary : {};
  const env = isPlainObject(input.env) ? input.env : process.env;
  const declaredOf = typeof input.declaredOf === 'function' ? input.declaredOf : () => ({});
  const prefsServers = isPlainObject(input.prefsServers) ? input.prefsServers : {};
  const provisionFailures = isPlainObject(input.provisionFailures) ? input.provisionFailures : {};
  const now = Number.isFinite(input.now) ? input.now : Date.now();

  // 命令可执行性用「补齐后的 PATH」判断：GUI 宿主的 PATH 缺 node/npx 时会误报 command-missing。
  const commandEnv = { ...env, PATH: augmentedPath(env.PATH) };

  const findings = [];
  const seen = new Set();
  const push = ({ severity, code, serverName, title, detail, fix, params }) => {
    const key = `${code}|${serverName ?? ''}|${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      severity,
      code,
      ...(serverName !== undefined ? { serverName } : {}),
      title,
      detail,
      fix,
      ...(params !== undefined ? { params } : {}),
    });
  };

  if (typeof input.storeError === 'string' && input.storeError !== '') {
    push({
      severity: 'error',
      code: 'store-load-error',
      title: '受管存储读取失败',
      detail: truncate(input.storeError, 300),
      fix: '用 mcp_manager_store_repair 修复（坏文件会改名备份），或手动删除受管存储文件。',
    });
  }
  if (typeof input.prefsError === 'string' && input.prefsError !== '') {
    push({
      severity: 'warn',
      code: 'prefs-load-error',
      title: '偏好存储读取失败',
      detail: truncate(input.prefsError, 300),
      fix: '收藏/标签/探针历史暂时不可用；可删除偏好文件后重试。',
    });
  }

  // 同名条目共享工具命名空间，按 serverName 去重后做配置类检查。
  const byName = new Map();
  for (const server of servers) {
    const name = typeof server?.serverName === 'string' ? server.serverName : '';
    if (name === '') continue;
    const list = byName.get(name) ?? [];
    list.push(server);
    byName.set(name, list);
  }

  const endpointOwners = new Map();
  let neverProbed = 0;
  let probedServers = 0;

  for (const [serverName, group] of byName) {
    const server = group[0];
    const status = typeof server.status === 'string' ? server.status : 'unknown';
    const enabled = server.enabled !== false;
    // 停用的服务不可能「现在就是坏的」：配置问题降级为 warn，避免刷一片红。
    const strict = enabled ? 'error' : 'warn';

    if (status === 'failed') {
      const reason = provisionFailures[serverName] ?? server.error;
      push({
        severity: strict,
        code: 'status-failed',
        serverName,
        title: '服务启动失败',
        detail: reason !== undefined ? truncate(String(reason), 300) : '条目已启用但没有加载出 fiber（常见原因是 serverName 冲突或客户端 apply 抛错）。',
        fix: '先 mcp_manager_probe 看握手错误；若是同名冲突，给其中一个换 serverName 或移除重复条目。',
      });
    } else if (status === 'not-provisioned') {
      const reason = provisionFailures[serverName] ?? server.error;
      push({
        severity: strict,
        code: 'status-not-provisioned',
        serverName,
        title: '受管记录未生效',
        detail: reason !== undefined ? truncate(String(reason), 300) : '记录在存储里，但本次启动没有创建出 loader 条目。',
        fix: 'mcp_manager_set_enabled 重试一次；仍失败时检查 serverName 是否与 profile 行冲突。',
      });
    } else if (status === 'no-tools' && enabled) {
      push({
        severity: 'warn',
        code: 'status-no-tools',
        serverName,
        title: '连接成功但没有工具',
        detail: '条目已加载，但工具注册表里没有 mcp__<serverName>__* 条目。',
        fix: '用 mcp_manager_probe 确认服务端 initialize/tools/list；某些服务确实不提供工具（只有资源/提示词），属正常。',
      });
    }

    const declared = declaredOf(server);
    const strings = declaredStrings(declared);

    // ── 占位符解析 ──
    const availableEnv = new Set(Object.keys(env));
    if (isPlainObject(declared.env)) {
      for (const key of Object.keys(declared.env)) availableEnv.add(key);
    }
    const missingEnv = new Map();
    const inputVars = new Map();
    for (const item of strings) {
      for (const placeholder of findPlaceholders(item.value)) {
        if (placeholder.kind === 'input') {
          const where = inputVars.get(placeholder.name) ?? [];
          where.push(item.path);
          inputVars.set(placeholder.name, where);
          continue;
        }
        if (placeholder.hasDefault) continue;
        if (availableEnv.has(placeholder.name)) continue;
        const where = missingEnv.get(placeholder.name) ?? [];
        where.push(item.path);
        missingEnv.set(placeholder.name, where);
      }
      for (const name of findJsEnvRefs(item.jsExpr)) {
        if (availableEnv.has(name)) continue;
        const where = missingEnv.get(name) ?? [];
        where.push(item.path);
        missingEnv.set(name, where);
      }
    }
    if (missingEnv.size > 0) {
      const names = [...missingEnv.keys()];
      push({
        severity: strict,
        code: 'env-missing',
        serverName,
        title: `缺少环境变量：${names.join('、')}`,
        detail: names
          .map((name) => `${name} ← ${uniqueSorted(missingEnv.get(name)).join('、')}`)
          .join('；'),
        fix: '在 ~/.dsh/.env 里补上这些变量（或改成字面量/受管记录里的 env），然后重启 DSH 或重新探测。',
        params: { names },
      });
    }
    if (inputVars.size > 0) {
      push({
        severity: 'warn',
        code: 'input-variable',
        serverName,
        title: '含交互式变量 ${input:…}',
        detail: `${[...inputVars.keys()].join('、')}（出现在 ${[...new Set([...inputVars.values()].flat())].join('、')}）`,
        fix: '${input:…} 是 VS Code 的交互输入语法，DSH 不会弹窗；请在受管记录里改成 ${VAR} 或字面量。',
      });
    }

    // ── stdio 可启动性 ──
    if (declared.transport === 'stdio') {
      const command = declared.command;
      const commandIsExpr = isJsExpr(command);
      if (!commandIsExpr && typeof command === 'string' && command !== '' && !findPlaceholders(command).length && !commandResolves(command, commandEnv)) {
        push({
          severity: strict,
          code: 'command-missing',
          serverName,
          title: `找不到可执行文件：${command}`,
          detail: 'PATH 里没有这个命令（或文件不可执行），stdio 服务不可能启动。',
          fix: '改成绝对路径，或先安装它（npx/uvx 类的先确认 node/python 在 PATH 里），再探测一次。',
        });
      }
      if (typeof declared.cwd === 'string' && declared.cwd !== '' && !findPlaceholders(declared.cwd).length && !directoryExists(declared.cwd)) {
        push({
          severity: 'warn',
          code: 'cwd-missing',
          serverName,
          title: '工作目录不存在',
          detail: declared.cwd,
          fix: '把 cwd 改成存在的目录，或清空它（默认使用 DSH 进程的工作目录）。',
        });
      }
    }

    // ── 配置卫生 ──
    if (isPlainObject(declared.env)) {
      const empties = Object.entries(declared.env).filter(([, value]) => value === '').map(([key]) => key);
      if (empties.length > 0) {
        push({
          severity: 'info',
          code: 'env-empty',
          serverName,
          title: '环境变量值为空',
          detail: empties.join('、'),
          fix: '空值通常表示「还没填」；如果服务端把空串当有效值可以忽略。',
        });
      }
    }
    if (Array.isArray(server.riskFlags) && server.riskFlags.length > 0) {
      push({
        severity: 'warn',
        code: 'config-risk',
        serverName,
        title: '配置里有明文凭据或 shell 展开',
        detail: server.riskFlags.map(RISK_LABEL).join('、'),
        fix: '把凭据挪到 ${ENV} 或 ~/.dsh/.env；args 里的 $()/反引号会被 shell 展开时才有风险，建议改成显式参数。',
        params: { flags: server.riskFlags },
      });
    }

    // ── enabled 漂移（受管记录 vs 运行时条目） ──
    for (const item of group) {
      if (item.origin !== 'managed') continue;
      if (item.runtimeOnly === true) {
        push({
          severity: 'info',
          code: 'runtime-only',
          serverName,
          title: '仅本次运行有效',
          detail: '这条受管条目没有落盘（persist:false），重启后会消失。',
          fix: '需要长期保留就用 mcp_manager_add 重新接入（默认持久化）。',
        });
      }
      if (typeof item.recordEnabled === 'boolean' && item.recordEnabled !== item.enabled) {
        push({
          severity: 'warn',
          code: 'enabled-drift',
          serverName,
          title: '受管记录与运行时启停状态不一致',
          detail: `记录 enabled=${item.recordEnabled}，运行时 enabled=${item.enabled}`,
          fix: '在面板里重新点一次启停开关，让记录和条目对齐。',
        });
      }
    }

    // ── 重复端点 ──
    // 用「声明值」算指纹：stdio 的展示串只有「命令名 + 参数个数」，
    // 三个 zhihu 服务都是 node（+4 个参数）会被误判成重复端点。
    const fingerprint = endpointFingerprint(declared);
    if (fingerprint !== '') {
      const owners = endpointOwners.get(fingerprint) ?? [];
      owners.push({ serverName, display: endpointOf(declared) || server.endpoint || '' });
      endpointOwners.set(fingerprint, owners);
    }

    // ── 探针健康 ──
    const meta = isPlainObject(prefsServers[serverName]) ? prefsServers[serverName] : {};
    const probe = isPlainObject(meta.probe) ? meta.probe : undefined;
    if (probe !== undefined) {
      probedServers += 1;
      if (probe.ok === false && enabled) {
        push({
          severity: 'warn',
          code: 'probe-failing',
          serverName,
          title: '最近一次探针失败',
          detail: `${new Date(probe.at).toISOString()}${probe.errorCode ? ` · ${probe.errorCode}` : ''}${probe.error ? ` · ${truncate(probe.error, 200)}` : ''}`,
          fix: '先看端点/凭据/网络；服务端临时故障可以稍后再探测一次。',
        });
      }
    } else if (enabled) {
      neverProbed += 1;
    }
  }

  for (const owners of endpointOwners.values()) {
    const unique = uniqueSorted(owners.map((owner) => owner.serverName));
    if (unique.length < 2) continue;
    const display = owners.find((owner) => owner.display !== '')?.display ?? '(相同声明)';
    push({
      severity: 'warn',
      code: 'duplicate-endpoint',
      title: `多个服务指向同一端点（${unique.length} 个）`,
      detail: `${unique.join('、')} → ${display}`,
      fix: '如果是同一个服务的不同命名空间，可以保留；否则移除多余条目，避免重复消耗工具额度。',
      params: { servers: unique },
    });
  }

  for (const [serverName, group] of byName) {
    if (group.length < 2) continue;
    push({
      severity: 'warn',
      code: 'duplicate-name',
      serverName,
      title: '同名条目（共享工具命名空间）',
      detail: group.map((server) => `${server.id}（${server.origin === 'managed' ? '受管' : 'profile'}）`).join('；'),
      fix: '同名条目会互相顶掉 fiber（常见 failed 原因）；保留一条，或给受管记录换 serverName。',
    });
  }

  if (Number(summaryIn.orphanToolCount) > 0) {
    push({
      severity: 'warn',
      code: 'orphan-tools',
      title: `有 ${summaryIn.orphanToolCount} 个工具没有归属服务`,
      detail: '工具命名空间 mcp__<serverName>__ 里的 serverName 已不在清单中（条目被移除但工具仍注册）。',
      fix: '重启 DSH 让工具注册表重新同步；若持续存在，检查是否有重复 serverName 的残留条目。',
    });
  }

  if (neverProbed > 0) {
    push({
      severity: 'info',
      code: 'never-probed',
      title: `有 ${neverProbed} 个已启用服务还没有探针记录`,
      detail: '「已连接」只表示工具已注册，不代表服务端业务可用。',
      fix: '在面板里点「全部探测」，或 mcp_manager_probe_many；探针只做 initialize + tools/list。',
      params: { count: neverProbed },
    });
  }

  findings.sort((left, right) => (SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity])
    || String(left.serverName ?? '').localeCompare(String(right.serverName ?? ''))
    || left.code.localeCompare(right.code));

  const counts = { error: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;

  return {
    generatedAt: new Date(now).toISOString(),
    durationMs: Date.now() - started,
    summary: {
      ...counts,
      findings: findings.length,
      servers: byName.size,
      probed: probedServers,
      neverProbed,
    },
    findings,
  };
}

