/**
 * 进程 PATH 补齐：GUI 启动的 app 拿不到登录 shell 的 PATH。
 *
 * macOS 上从 Finder/Launchpad 启动的 DeepSeek Harness，`process.env.PATH` 往往只有
 * `/usr/bin:/bin:/usr/sbin:/sbin`。于是 `npx` / `node` / `uvx` 这类靠 `#!/usr/bin/env node`
 * 运行的命令会直接以 127 退出（stderr 是 `env: node: No such file or directory`）——
 * 这不是服务的问题，是探针子进程的 PATH 太窄。
 *
 * 本模块只**增加**目录、不删除：先放「确定含 node 可执行文件」的目录（保证 shebang 能跑），
 * 再追加常见用户级目录（python/uv 工具常在这里），最后保留原 PATH。
 */
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

function isDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function hasExecutable(dir, name) {
  try {
    accessSync(join(dir, name), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 把 `v24.17.0` 之类的目录名转成可比较的版本数组。 */
function versionParts(name) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(name));
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** nvm 里版本号最大的 node 目录（没有 nvm 时返回 undefined）。 */
function newestNvmBin(home) {
  const root = join(home, '.nvm', 'versions', 'node');
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, version: versionParts(entry.name) }))
    .filter((item) => item.version !== undefined)
    .sort((left, right) => {
      for (let index = 0; index < 3; index += 1) {
        if (left.version[index] !== right.version[index]) return right.version[index] - left.version[index];
      }
      return 0;
    });
  for (const candidate of candidates) {
    const bin = join(root, candidate.name, 'bin');
    if (hasExecutable(bin, 'node')) return bin;
  }
  return undefined;
}

/**
 * 计算「对子进程友好」的 PATH。
 *
 * @param {string} [current] - 当前 PATH（默认 process.env.PATH）。
 * @param {object} [options]
 * @param {string} [options.home] - HOME（默认 process.env.HOME）。
 * @param {string} [options.execPath] - 当前可执行文件（默认 process.execPath）。
 * @returns {string} 补全后的 PATH。
 */
export function augmentedPath(current = process.env.PATH, options = {}) {
  const home = typeof options.home === 'string' ? options.home : (process.env.HOME ?? '');
  const execPath = typeof options.execPath === 'string' ? options.execPath : (process.execPath ?? '');
  const existing = String(current ?? '').split(':').filter((dir) => dir !== '');

  // 1) 一定含 node 的目录：放在最前面，保证 `#!/usr/bin/env node` 能解析。
  const nodeDirs = [];
  const pushNodeDir = (dir) => {
    if (typeof dir === 'string' && dir !== '' && hasExecutable(dir, 'node') && !nodeDirs.includes(dir)) nodeDirs.push(dir);
  };
  pushNodeDir(dirname(execPath));
  if (home !== '') pushNodeDir(newestNvmBin(home));
  for (const dir of [
    home !== '' ? join(home, '.local', 'bin') : undefined,
    home !== '' ? join(home, '.volta', 'bin') : undefined,
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]) pushNodeDir(dir);

  // 2) 其它用户级目录：python/uv 工具常在这里，只追加不抢占。
  const extraDirs = [];
  for (const dir of [
    home !== '' ? join(home, '.local', 'bin') : undefined,
    home !== '' ? join(home, '.asdf', 'shims') : undefined,
    home !== '' ? join(home, '.bun', 'bin') : undefined,
    home !== '' ? join(home, 'Library', 'pnpm') : undefined,
    home !== '' ? join(home, '.pyenv', 'shims') : undefined,
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]) {
    if (typeof dir !== 'string' || dir === '') continue;
    if (nodeDirs.includes(dir) || extraDirs.includes(dir)) continue;
    if (isDirectory(dir)) extraDirs.push(dir);
  }

  const merged = [...nodeDirs, ...existing, ...extraDirs];
  const seen = new Set();
  const unique = [];
  for (const dir of merged) {
    if (dir === '' || seen.has(dir)) continue;
    seen.add(dir);
    unique.push(dir);
  }
  return unique.join(':');
}
