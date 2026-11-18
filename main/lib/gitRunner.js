'use strict';

/**
 * Git / OpenSSH 可执行文件定位与命令执行
 * ------------------------------------------------------------
 * 本机可能的情况：
 *   1. Git 已装但不在 PATH（常见于只装了 GUI 客户端）
 *   2. Git 完全未安装
 *   3. ssh 在 PATH 中缺失，但 C:\Windows\System32\OpenSSH 存在
 * 因此这里统一走「配置指定 → 常见路径 → PATH 扫描」三级探测，
 * 并把 ssh 所在目录注入子进程 PATH，保证 git 调用 ssh 时能找到它。
 * @author yittiger
 */

const fs = require('fs');
const path = require('path');
const { runCommand } = require('./proc');
const store = require('./store');

const isWindows = process.platform === 'win32';
const PATH_SEP = isWindows ? ';' : ':';

/** 缓存：避免每次操作都扫盘 */
const cache = { git: undefined, ssh: undefined, keygen: undefined };

const GIT_CANDIDATES = [
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files\\Git\\bin\\git.exe',
  'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
  'C:\\Program Files\\TortoiseGit\\bin\\git.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'),
  'D:\\Program Files\\Git\\cmd\\git.exe'
].filter(Boolean);

const SSH_CANDIDATES = [
  'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
  path.join(process.env.ProgramFiles || '', 'Git', 'usr', 'bin', 'ssh.exe')
].filter(Boolean);

const KEYGEN_CANDIDATES = [
  'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe',
  path.join(process.env.ProgramFiles || '', 'Git', 'usr', 'bin', 'ssh-keygen.exe')
].filter(Boolean);

/**
 * 在 PATH 中查找可执行文件
 * @param {string[]} names 候选文件名（不含扩展名或含扩展名）
 * @returns {string|null}
 */
function findInPath(names) {
  const dirs = (process.env.PATH || '').split(PATH_SEP).filter(Boolean);
  const exts = isWindows ? ['.exe', '.cmd', ''] : [''];
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
        } catch (err) {
          /* 目录不可读则跳过 */
        }
      }
    }
  }
  return null;
}

/**
 * 通用的可执行文件解析
 * @param {string} override 用户手动配置的路径
 * @param {string[]} candidates 常见安装路径
 * @param {string[]} pathNames PATH 中查找的名字
 * @returns {string|null}
 */
function resolveBinary(override, candidates, pathNames) {
  const trimmed = override && String(override).trim();
  if (trimmed) {
    try {
      if (fs.existsSync(trimmed)) return trimmed;
    } catch (err) {
      /* 配置路径无效则继续探测 */
    }
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (err) {
      /* 忽略 */
    }
  }
  return findInPath(pathNames);
}

/**
 * 解析 git 路径
 * @returns {string|null}
 */
function resolveGit() {
  if (cache.git !== undefined) return cache.git;
  cache.git = resolveBinary(store.getSetting('gitPath', ''), GIT_CANDIDATES, ['git']);
  return cache.git;
}

/**
 * 解析 ssh 路径
 * @returns {string|null}
 */
function resolveSsh() {
  if (cache.ssh !== undefined) return cache.ssh;
  let resolved = resolveBinary(store.getSetting('sshPath', ''), SSH_CANDIDATES, ['ssh']);
  // PATH 里没有，但 git 自带 ssh 时兜底
  if (!resolved) {
    const gitPath = resolveGit();
    if (gitPath) {
      const guess = path.join(path.dirname(gitPath), '..', 'usr', 'bin', 'ssh.exe');
      if (fs.existsSync(guess)) resolved = guess;
    }
  }
  cache.ssh = resolved;
  return resolved;
}

/**
 * 解析 ssh-keygen 路径
 * @returns {string|null}
 */
function resolveSshKeygen() {
  if (cache.keygen !== undefined) return cache.keygen;
  cache.keygen = resolveBinary(store.getSetting('sshKeygenPath', ''), KEYGEN_CANDIDATES, ['ssh-keygen']);
  return cache.keygen;
}

/**
 * 清空探测缓存（设置变更后调用）
 */
function clearCache() {
  cache.git = undefined;
  cache.ssh = undefined;
  cache.keygen = undefined;
}

/**
 * 构造子进程环境变量：把 ssh / git 目录补进 PATH
 * @returns {object} 环境变量增量
 */
function buildEnv() {
  const extraDirs = [];
  const sshPath = resolveSsh();
  const gitPath = resolveGit();
  if (sshPath) extraDirs.push(path.dirname(sshPath));
  if (gitPath) extraDirs.push(path.dirname(gitPath));

  if (!extraDirs.length) return {};
  return { PATH: extraDirs.join(PATH_SEP) + PATH_SEP + (process.env.PATH || '') };
}

/**
 * 执行 git 命令
 * @param {string[]} args 参数
 * @param {object} [options] { cwd, timeout, input, onStdout, onStderr }
 * @returns {Promise<object>}
 */
async function runGit(args, options) {
  const gitPath = resolveGit();
  if (!gitPath) {
    return {
      ok: false,
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      duration: 0,
      error: '未检测到 Git，请在「设置」中指定 git.exe 路径，或先安装 Git for Windows'
    };
  }
  const opts = Object.assign({}, options || {}, { env: buildEnv() });
  const result = await runCommand(gitPath, args, opts);
  result.command = 'git ' + args.join(' ');
  return result;
}

/**
 * 执行 ssh 命令
 * @param {string[]} args 参数
 * @param {object} [options] 同 runGit
 * @returns {Promise<object>}
 */
async function runSsh(args, options) {
  const sshPath = resolveSsh();
  if (!sshPath) {
    return {
      ok: false,
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      duration: 0,
      error: '未检测到 ssh，请启用 Windows OpenSSH 客户端，或在「设置」中指定 ssh.exe 路径'
    };
  }
  const opts = Object.assign({}, options || {}, { env: buildEnv() });
  const result = await runCommand(sshPath, args, opts);
  result.command = 'ssh ' + args.join(' ');
  return result;
}

/**
 * 执行 ssh-keygen
 * @param {string[]} args 参数
 * @param {object} [options] 同上
 * @returns {Promise<object>}
 */
async function runKeygen(args, options) {
  const keygenPath = resolveSshKeygen();
  if (!keygenPath) {
    return {
      ok: false,
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      duration: 0,
      error: '未检测到 ssh-keygen，请启用 Windows OpenSSH 客户端'
    };
  }
  const opts = Object.assign({}, options || {}, { env: buildEnv() });
  const result = await runCommand(keygenPath, args, opts);
  result.command = 'ssh-keygen ' + args.join(' ');
  return result;
}

/**
 * 判断目录是否是 git 仓库（向上查找 .git）
 * @param {string} dir 目录
 * @returns {boolean}
 */
function isGitRepo(dir) {
  if (!dir) return false;
  try {
    let current = path.resolve(dir);
    for (let i = 0; i < 40; i += 1) {
      if (fs.existsSync(path.join(current, '.git'))) return true;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch (err) {
    return false;
  }
  return false;
}

/**
 * 查询 git / ssh / ssh-keygen 版本，用于环境体检
 * @returns {Promise<object>}
 */
async function probeVersions() {
  const result = {
    git: { path: resolveGit(), version: '', available: false, error: '' },
    ssh: { path: resolveSsh(), version: '', available: false, error: '' },
    sshKeygen: { path: resolveSshKeygen(), version: '', available: false, error: '' }
  };

  if (result.git.path) {
    const git = await runGit(['--version'], { timeout: 8000 });
    result.git.available = git.ok;
    result.git.version = git.stdout.trim();
    result.git.error = git.ok ? '' : (git.error || git.stderr.trim());
  } else {
    result.git.error = '未找到 git.exe';
  }

  if (result.ssh.path) {
    const ssh = await runSsh(['-V'], { timeout: 8000 });
    result.ssh.available = !ssh.error;
    // ssh -V 输出走 stderr
    result.ssh.version = (ssh.stderr || ssh.stdout).trim();
    result.ssh.error = ssh.error || '';
  } else {
    result.ssh.error = '未找到 ssh.exe';
  }

  if (result.sshKeygen.path) {
    const keygen = await runKeygen(['-h'], { timeout: 8000 });
    result.sshKeygen.available = Boolean(result.sshKeygen.path);
    result.sshKeygen.version = '可用';
    result.sshKeygen.error = '';
  } else {
    result.sshKeygen.error = '未找到 ssh-keygen.exe';
  }

  return result;
}

module.exports = {
  resolveGit,
  resolveSsh,
  resolveSshKeygen,
  clearCache,
  runGit,
  runSsh,
  runKeygen,
  isGitRepo,
  probeVersions,
  buildEnv
};
