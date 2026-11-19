'use strict';

/**
 * SSH 客户端实现探测与切换
 * ------------------------------------------------------------
 * 别名方案（Host gitee-work / IdentityFile / IdentitiesOnly）完全建立在
 * OpenSSH 的 config 语义上。PuTTY 系的 plink / TortoisePlink 不读
 * ~/.ssh/config，它只认 PuTTY 自己的 session 列表，于是：
 *
 *   git@gitee-dojustek:owner/repo.git
 *   → Unable to open connection: Host does not exist
 *
 * 这类报错看起来像「没有权限 / 密钥没配好」，实际是客户端换了实现。
 * 本模块负责把「git 实际会调用哪个 ssh」查清楚，并给出两条路：
 *   1. 推荐：切回 OpenSSH（别名机制立刻恢复）
 *   2. 必须用 plink 时：生成兼容配置（core.sshCommand + .ppk）
 * @author yittiger
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const gitRunner = require('./gitRunner');

/** TortoiseGit 的设置根键（用户级） */
const TORTOISE_REG_KEY = 'HKCU\\Software\\TortoiseGit';
/** Windows 用户级环境变量所在键 */
const USER_ENV_REG_KEY = 'HKCU\\Environment';
/** OpenSSH 常用安装位置 */
const OPENSSH_CANDIDATES = [
  'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
  'C:\\Program Files\\OpenSSH\\ssh.exe'
];

/**
 * 判定一个路径属于哪种 SSH 实现
 * @param {string} binPath 可执行文件路径或命令名
 * @returns {'plink'|'openssh'|'unknown'|'none'}
 */
function classify(binPath) {
  const value = String(binPath || '').trim();
  if (!value) return 'none';
  const base = value.replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (base.indexOf('plink') >= 0) return 'plink';
  if (base === 'ssh' || base === 'ssh.exe' || base.indexOf('openssh') >= 0) return 'openssh';
  return 'unknown';
}

/**
 * 读取注册表字符串值（读不到返回空字符串）
 * @param {string} regKey 注册表键，例如 HKCU\\Software\\TortoiseGit
 * @param {string} valueName 值名
 * @returns {string}
 */
function readRegistryString(regKey, valueName) {
  try {
    const out = execFileSync('reg.exe', ['query', regKey, '/v', valueName], {
      encoding: 'utf8',
      windowsHide: true,
      // 值不存在时 reg.exe 会往 stderr 打一行「找不到指定的注册表项或值」，这里直接丢弃
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const line = out.split(/\r?\n/).find((row) => {
      const text = row.trim();
      return text.toLowerCase().startsWith(String(valueName).toLowerCase() + ' ');
    });
    if (!line) return '';
    // 格式：    SSH    REG_SZ    d:\mysoft\TortoiseGit\bin\TortoisePlink.exe
    const parts = line.trim().split(/\s{2,}/);
    return parts.length >= 3 ? parts.slice(2).join('  ').trim() : '';
  } catch (err) {
    return '';
  }
}

/**
 * 写入注册表字符串值
 * @param {string} regKey 注册表键
 * @param {string} valueName 值名
 * @param {string} value 新值
 * @returns {{ok:boolean, error?:string}}
 */
function writeRegistryString(regKey, valueName, value) {
  try {
    execFileSync('reg.exe', ['add', regKey, '/v', valueName, '/t', 'REG_SZ', '/d', value, '/f'], {
      encoding: 'utf8',
      windowsHide: true
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * 找一个可用的 OpenSSH 客户端
 * @returns {string}
 */
function resolveOpenSshPath() {
  const viaGitRunner = gitRunner.resolveSsh();
  if (viaGitRunner) return viaGitRunner;
  for (const candidate of OPENSSH_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Git 自带 ssh 兜底
  const gitPath = gitRunner.resolveGit();
  if (gitPath) {
    const guess = path.join(path.dirname(gitPath), '..', 'usr', 'bin', 'ssh.exe');
    if (fs.existsSync(guess)) return guess;
  }
  return '';
}

/**
 * 收集所有可能生效的 SSH 实现来源
 * ------------------------------------------------------------
 * 优先级与 git 自身一致：GIT_SSH_COMMAND > GIT_SSH > core.sshCommand
 * > PATH 里的 ssh。TortoiseGit 的 SSH 设置只影响它自己拉起的 git
 * 子进程（GUI 操作），因此单独标注作用域。
 * @param {object} [overrides] 测试用注入，正常调用不传
 * @returns {object}
 */
function detect(overrides) {
  const injected = overrides || {};
  const env = injected.env || process.env;
  const sources = [];

  const pushSource = (key, value, scope) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;
    sources.push({ key: key, value: trimmed, kind: classify(trimmed), scope: scope });
  };

  // 1) 进程环境（当前会话）
  pushSource('GIT_SSH_COMMAND', env.GIT_SSH_COMMAND, 'env');
  pushSource('GIT_SSH', env.GIT_SSH, 'env');

  // 2) 用户级持久环境变量（新开终端才生效，也是「改了设置却没效果」的常见来源）
  if (!injected.userEnv) {
    injected.userEnv = {
      GIT_SSH_COMMAND: readRegistryString(USER_ENV_REG_KEY, 'GIT_SSH_COMMAND'),
      GIT_SSH: readRegistryString(USER_ENV_REG_KEY, 'GIT_SSH')
    };
  }
  if (!env.GIT_SSH_COMMAND) pushSource('GIT_SSH_COMMAND（用户环境变量）', injected.userEnv.GIT_SSH_COMMAND, 'persisted-env');
  if (!env.GIT_SSH) pushSource('GIT_SSH（用户环境变量）', injected.userEnv.GIT_SSH, 'persisted-env');

  // 3) git 全局 core.sshCommand
  let globalSshCommand = injected.globalSshCommand;
  if (typeof globalSshCommand === 'undefined') {
    try {
      globalSshCommand = execFileSync('git', ['config', '--global', '--get', 'core.sshCommand'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch (err) {
      globalSshCommand = '';
    }
  }
  pushSource('core.sshCommand（global）', globalSshCommand, 'git-config');

  // 4) TortoiseGit GUI 设置
  let tortoiseSsh = injected.tortoiseGitSsh;
  if (typeof tortoiseSsh === 'undefined') tortoiseSsh = readRegistryString(TORTOISE_REG_KEY, 'SSH');
  pushSource('TortoiseGit SSH', tortoiseSsh, 'gui');

  // 5) PATH 上兜底的 ssh（git 没有上面任何覆盖时用它）
  const pathSsh = injected.pathSsh || resolveOpenSshPath();
  if (pathSsh) sources.push({ key: 'PATH ssh', value: pathSsh, kind: classify(pathSsh), scope: 'path' });

  // 命令行的“实际生效”来源：第一个 env / git-config 级来源
  const effective = sources.find((item) => item.scope === 'env' || item.scope === 'persisted-env' || item.scope === 'git-config')
    || sources.find((item) => item.scope === 'path')
    || { key: '未探测到', value: '', kind: 'none', scope: 'none' };

  const plinkSources = sources.filter((item) => item.kind === 'plink');
  const guiPlink = sources.some((item) => item.scope === 'gui' && item.kind === 'plink');

  return {
    ok: plinkSources.length === 0,
    sources: sources,
    effective: effective,
    plinkSources: plinkSources,
    guiPlink: guiPlink,
    tortoiseGitSsh: tortoiseSsh || '',
    openSshPath: resolveOpenSshPath()
  };
}

/**
 * 把 TortoiseGit 的 SSH 客户端切到 OpenSSH
 * @returns {{ok:boolean, oldValue?:string, newValue?:string, error?:string}}
 */
function switchTortoiseGitToOpenSsh() {
  const target = resolveOpenSshPath();
  if (!target) {
    return { ok: false, error: '未找到可用的 OpenSSH 客户端（ssh.exe），请先在「设置」里指定 ssh 路径' };
  }
  const oldValue = readRegistryString(TORTOISE_REG_KEY, 'SSH');
  if (classify(oldValue) === 'openssh' && oldValue === target) {
    return { ok: true, oldValue: oldValue, newValue: target, changed: false };
  }
  const written = writeRegistryString(TORTOISE_REG_KEY, 'SSH', target);
  if (!written.ok) return { ok: false, error: written.error, oldValue: oldValue };
  const verified = readRegistryString(TORTOISE_REG_KEY, 'SSH');
  if (verified !== target) {
    return { ok: false, error: '写入后校验不一致，可能是权限被策略限制（当前值：' + verified + '）', oldValue: oldValue };
  }
  return { ok: true, oldValue: oldValue, newValue: verified, changed: true };
}

/**
 * 生成「必须继续用 plink」时的兼容方案
 * ------------------------------------------------------------
 * plink 不认 config，也没有 -o IdentityFile 这套语义，只能靠：
 *   1. 私钥转成 PuTTY 的 .ppk
 *   2. 仓库级 core.sshCommand 显式指定 plink + -i
 * 这里只生成命令文本，不替用户执行转换，避免误动密钥文件。
 * @param {object} account 账号对象
 * @returns {{convertCommand:string, sshCommand:string, ppkPath:string, note:string}}
 */
function buildPlinkPlan(account) {
  const keyPath = String((account && account.keyPath) || '').replace(/\\/g, '/');
  const ppkPath = keyPath ? keyPath + '.ppk' : '';
  const plinkPath = String((detect().tortoiseGitSsh || 'plink')).replace(/\\/g, '/');
  return {
    ppkPath: ppkPath,
    convertCommand: keyPath
      ? 'puttygen "' + keyPath + '" -O private -o "' + ppkPath + '"'
      : 'puttygen <私钥路径> -O private -o <输出.ppk>',
    sshCommand: ppkPath
      ? 'git config --local core.sshCommand "plink -batch -i ' + ppkPath + '"'
      : 'git config --local core.sshCommand "plink -batch -i <私钥.ppk>"',
    note: '用 plink 时别名（Host 别名地址）不生效：必须把 remote 写回真实域名，' +
      '并由 core.sshCommand 显式指定私钥；仓库地址形如 git@' + ((account && account.hostName) || 'github.com') + ':owner/repo.git。' +
      '当前 plink：' + (plinkPath || '(未探测到)')
  };
}

module.exports = {
  TORTOISE_REG_KEY,
  classify,
  detect,
  switchTortoiseGitToOpenSsh,
  buildPlinkPlan,
  resolveOpenSshPath,
  readRegistryString
};
