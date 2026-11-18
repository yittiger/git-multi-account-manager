'use strict';

/**
 * 项目管理
 * ------------------------------------------------------------
 * 项目 = 一个本地 git 工作区，绑定某个账号后：
 *   1. remote 地址中的域名被替换成该账号的 SSH 别名（强制走对应私钥）
 *   2. 该仓库的 user.name / user.email 设为该账号的提交身份（local 级）
 * 这两条同时成立，才不会出现「推送到 A 账号仓库、提交签名却是 B 账号」的串号问题。
 * @author yittiger
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');
const gitRunner = require('./gitRunner');
const accounts = require('./accounts');

/**
 * 解析远程地址
 * @param {string} raw 远程地址
 * @returns {{protocol:string,user:string,host:string,port:number|null,path:string,raw:string}}
 */
function parseRemoteUrl(raw) {
  const text = String(raw || '').trim();
  const result = { protocol: 'unknown', user: '', host: '', port: null, path: '', raw: text };
  if (!text) return result;

  // 1) ssh://[user@]host[:port]/path
  const sshMatch = text.match(/^(ssh|git\+ssh):\/\/(?:([^@/]+)@)?([^/:]+)(?::(\d+))?\/(.*)$/i);
  if (sshMatch) {
    result.protocol = 'ssh';
    result.user = sshMatch[2] || 'git';
    result.host = sshMatch[3];
    result.port = sshMatch[4] ? Number(sshMatch[4]) : null;
    result.path = sshMatch[5].replace(/^\/+/, '');
    return result;
  }

  // 2) scp 风格 git@host:path（host 里不能有斜杠）
  const scpMatch = text.match(/^(?:([^@/]+)@)?([^/:]+):(.+)$/);
  if (scpMatch && !/^(https?|file)$/i.test(text.split(':')[0])) {
    result.protocol = 'ssh';
    result.user = scpMatch[1] || 'git';
    result.host = scpMatch[2];
    result.path = scpMatch[3].replace(/^\/+/, '');
    return result;
  }

  // 3) https:// / http://
  const httpMatch = text.match(/^(https?):\/\/(?:([^@/]+)@)?([^/:]+)(?::(\d+))?\/(.*)$/i);
  if (httpMatch) {
    result.protocol = 'https';
    result.user = httpMatch[2] || '';
    result.host = httpMatch[3];
    result.port = httpMatch[4] ? Number(httpMatch[4]) : null;
    result.path = httpMatch[5];
    return result;
  }

  return result;
}

/**
 * 用账号别名重建远程地址（scp 形式，端口由 ssh config 的 Port 生效）
 * @param {object} account 账号
 * @param {string} repoPath 仓库路径 owner/repo.git
 * @returns {string}
 */
function buildAliasUrl(account, repoPath) {
  const clean = String(repoPath || '').replace(/^[/\\]+/, '');
  return 'git@' + account.alias + ':' + clean;
}

/**
 * 判断远程地址是否已经使用了账号别名
 * @param {string} raw 远程地址
 * @param {object} account 账号
 * @returns {boolean}
 */
function isUsingAlias(raw, account) {
  const parsed = parseRemoteUrl(raw);
  if (parsed.protocol !== 'ssh') return false;
  return String(parsed.host || '').toLowerCase() === String(account.alias || '').toLowerCase();
}

/**
 * 生成「绑定预览」：告诉用户会改哪些东西
 * @param {string} projectId 项目 ID
 * @param {string} accountId 账号 ID
 * @returns {Promise<object>}
 */
async function previewBind(projectId, accountId) {
  const project = find(projectId);
  if (!project) return { ok: false, error: '项目不存在' };
  const account = accounts.find(accountId);
  if (!account) return { ok: false, error: '账号不存在' };

  const remotes = await getRemotes(projectId);
  const identity = await getLocalIdentity(projectId);
  const remoteName = project.remoteName || 'origin';
  const current = (remotes.items || []).find((item) => item.name === remoteName);

  const parsed = current ? parseRemoteUrl(current.url) : null;
  const nextUrl = parsed && parsed.path ? buildAliasUrl(account, parsed.path) : '';

  return {
    ok: true,
    project: project,
    account: account,
    remoteName: remoteName,
    currentUrl: current ? current.url : '',
    nextUrl: nextUrl,
    currentIdentity: identity,
    nextIdentity: { name: account.userName, email: account.userEmail },
    changes: {
      remote: Boolean(current && nextUrl && current.url !== nextUrl),
      identity: identity.name !== account.userName || identity.email !== account.userEmail
    }
  };
}

/**
 * 绑定账号：改写 remote + 设置仓库级提交身份
 * @param {string} projectId 项目 ID
 * @param {string} accountId 账号 ID
 * @param {object} [options] { rewriteRemote=true, applyIdentity=true, remoteName='origin', url }
 * @returns {Promise<object>}
 */
async function bind(projectId, accountId, options) {
  const opts = options || {};
  const project = find(projectId);
  if (!project) return { ok: false, error: '项目不存在' };
  const account = accounts.find(accountId);
  if (!account) return { ok: false, error: '账号不存在' };

  const remoteName = opts.remoteName || project.remoteName || 'origin';
  const steps = [];

  if (opts.rewriteRemote !== false) {
    let repoPath = '';
    if (opts.url) {
      repoPath = parseRemoteUrl(opts.url).path;
    } else {
      const remotes = await getRemotes(projectId);
      const current = (remotes.items || []).find((item) => item.name === remoteName);
      repoPath = current ? parseRemoteUrl(current.url).path : '';
    }
    // 远程可能走 SSH 别名或 https，都可以取出 owner/repo 路径
    if (!repoPath) {
      steps.push({ name: '改写远程地址', ok: false, message: '未能识别仓库路径，请手动填写仓库地址（如 owner/repo.git）' });
    } else {
      const url = buildAliasUrl(account, repoPath);
      const hasRemote = (await getRemotes(projectId)).items.some((item) => item.name === remoteName);
      const args = hasRemote
        ? ['remote', 'set-url', remoteName, url]
        : ['remote', 'add', remoteName, url];
      const result = await gitRunner.runGit(args, { cwd: project.path, timeout: 15000 });
      steps.push({
        name: '改写远程地址',
        ok: result.ok,
        message: result.ok ? url : (result.error || result.stderr.trim())
      });
    }
  }

  if (opts.applyIdentity !== false) {
    const setName = await gitRunner.runGit(['config', '--local', 'user.name', account.userName], { cwd: project.path });
    const setEmail = await gitRunner.runGit(['config', '--local', 'user.email', account.userEmail], { cwd: project.path });
    steps.push({
      name: '设置仓库提交身份',
      ok: setName.ok && setEmail.ok,
      message: setName.ok && setEmail.ok
        ? account.userName + ' <' + account.userEmail + '>'
        : (setName.error || setName.stderr.trim() || setEmail.error || setEmail.stderr.trim())
    });
  }

  const state = store.loadState();
  const index = state.projects.findIndex((item) => item.id === projectId);
  if (index >= 0) {
    state.projects[index].accountId = accountId;
    state.projects[index].remoteName = remoteName;
    state.projects[index].updatedAt = new Date().toISOString();
    store.saveState(state);
  }

  return { ok: steps.every((step) => step.ok), steps: steps };
}

/**
 * 读取项目的远程列表
 * @param {string} projectId 项目 ID
 * @returns {Promise<object>}
 */
async function getRemotes(projectId) {
  const project = find(projectId);
  if (!project) return { ok: false, items: [], error: '项目不存在' };

  const result = await gitRunner.runGit(['remote', '-v'], { cwd: project.path, timeout: 12000 });
  if (!result.ok) return { ok: false, items: [], error: result.error || result.stderr.trim() };

  const map = {};
  result.stdout.split(/\r?\n/).forEach((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3 && parts[2] === '(fetch)') {
      map[parts[0]] = { name: parts[0], url: parts[1], parsed: parseRemoteUrl(parts[1]) };
    }
  });
  return { ok: true, items: Object.keys(map).map((key) => map[key]) };
}

/**
 * 读取仓库级提交身份
 * @param {string} projectId 项目 ID
 * @returns {Promise<{name:string,email:string}>}
 */
async function getLocalIdentity(projectId) {
  const project = find(projectId);
  if (!project) return { name: '', email: '' };
  const nameResult = await gitRunner.runGit(['config', '--local', '--get', 'user.name'], { cwd: project.path, timeout: 8000 });
  const emailResult = await gitRunner.runGit(['config', '--local', '--get', 'user.email'], { cwd: project.path, timeout: 8000 });
  return {
    name: nameResult.ok ? nameResult.stdout.trim() : '',
    email: emailResult.ok ? emailResult.stdout.trim() : ''
  };
}

/**
 * 读取全局提交身份（用于诊断「全局覆盖风险」）
 * @returns {Promise<{name:string,email:string}>}
 */
async function getGlobalIdentity() {
  const nameResult = await gitRunner.runGit(['config', '--global', '--get', 'user.name'], { timeout: 8000 });
  const emailResult = await gitRunner.runGit(['config', '--global', '--get', 'user.email'], { timeout: 8000 });
  return {
    name: nameResult.ok ? nameResult.stdout.trim() : '',
    email: emailResult.ok ? emailResult.stdout.trim() : ''
  };
}

/**
 * 读取仓库运行态：分支、脏文件、ahead/behind、最近提交
 * @param {string} projectId 项目 ID
 * @returns {Promise<object>}
 */
async function getRuntime(projectId) {
  const project = find(projectId);
  if (!project) return { ok: false, error: '项目不存在' };

  if (!fs.existsSync(project.path)) {
    return { ok: false, error: '目录不存在：' + project.path };
  }
  if (!gitRunner.isGitRepo(project.path)) {
    return { ok: false, error: '该目录不是 Git 仓库' };
  }

  const statusResult = await gitRunner.runGit(['status', '--porcelain', '-b'], { cwd: project.path, timeout: 15000 });
  if (!statusResult.ok) {
    return { ok: false, error: statusResult.error || statusResult.stderr.trim() };
  }

  const lines = statusResult.stdout.split(/\r?\n/).filter((line) => line.trim().length);
  const branchLine = lines.find((line) => line.startsWith('##')) || '';
  const changed = lines.filter((line) => !line.startsWith('##'));

  let branch = '';
  let upstream = '';
  let ahead = 0;
  let behind = 0;
  let detached = false;
  let noUpstream = false;

  if (branchLine) {
    const text = branchLine.replace(/^##\s*/, '');
    if (text.startsWith('HEAD')) {
      detached = true;
      branch = '（detached HEAD）';
    } else {
      const parts = text.split('...');
      branch = parts[0].trim();
      upstream = (parts[1] || '').replace(/\s*\[.*$/, '').trim();
      const aheadMatch = text.match(/ahead\s+(\d+)/);
      const behindMatch = text.match(/behind\s+(\d+)/);
      if (aheadMatch) ahead = Number(aheadMatch[1]);
      if (behindMatch) behind = Number(behindMatch[1]);
      if (!upstream) noUpstream = true;
    }
  }

  const lastCommitResult = await gitRunner.runGit(
    ['log', '-1', '--pretty=format:%h%x1f%an%x1f%ae%x1f%ad%x1f%s', '--date=format:%Y-%m-%d %H:%M'],
    { cwd: project.path, timeout: 12000 }
  );
  let lastCommit = null;
  if (lastCommitResult.ok && lastCommitResult.stdout.trim()) {
    const fields = lastCommitResult.stdout.trim().split('\x1f');
    lastCommit = {
      hash: fields[0] || '',
      author: fields[1] || '',
      email: fields[2] || '',
      date: fields[3] || '',
      subject: fields[4] || ''
    };
  }

  const identity = await getLocalIdentity(projectId);
  const remotes = await getRemotes(projectId);
  const account = project.accountId ? accounts.find(project.accountId) : null;

  return {
    ok: true,
    project: project,
    branch: branch,
    upstream: upstream,
    ahead: ahead,
    behind: behind,
    detached: detached,
    noUpstream: noUpstream,
    dirtyCount: changed.length,
    changedFiles: changed.slice(0, 20).map((line) => ({ status: line.slice(0, 2), file: line.slice(3) })),
    lastCommit: lastCommit,
    identity: identity,
    remotes: remotes.items || [],
    account: account ? { id: account.id, label: account.label, alias: account.alias } : null
  };
}

/**
 * 列出项目（含派生状态）
 * @returns {object[]}
 */
function listWithStatus() {
  return store.loadState().projects.map((project) => {
    const account = project.accountId ? accounts.find(project.accountId) : null;
    return Object.assign({}, project, {
      exists: fs.existsSync(project.path),
      isRepo: gitRunner.isGitRepo(project.path),
      accountLabel: account ? account.label : '',
      accountAlias: account ? account.alias : ''
    });
  });
}

/**
 * 查找项目
 * @param {string} id 项目 ID
 * @returns {object|null}
 */
function find(id) {
  return store.loadState().projects.find((item) => item.id === id) || null;
}

/**
 * 添加项目
 * @param {object} payload { path, accountId, name, remoteName }
 * @returns {object}
 */
function add(payload) {
  const dirPath = path.resolve(String((payload && payload.path) || '').trim());
  if (!dirPath || !fs.existsSync(dirPath)) return { ok: false, error: '目录不存在：' + dirPath };
  if (!gitRunner.isGitRepo(dirPath)) return { ok: false, error: '目录不是 Git 仓库（未找到 .git）' };

  const state = store.loadState();
  if (state.projects.some((item) => path.resolve(item.path).toLowerCase() === dirPath.toLowerCase())) {
    return { ok: false, error: '该目录已在项目列表中' };
  }

  const project = {
    id: store.createId('prj'),
    name: String((payload && payload.name) || path.basename(dirPath)).trim(),
    path: dirPath,
    accountId: (payload && payload.accountId) || '',
    remoteName: (payload && payload.remoteName) || 'origin',
    addedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    note: (payload && payload.note) || ''
  };

  state.projects.push(project);
  store.saveState(state);
  return { ok: true, project: project };
}

/**
 * 移除项目（只从列表移除，不动磁盘文件）
 * @param {string} id 项目 ID
 * @returns {{ok:boolean}}
 */
function remove(id) {
  const state = store.loadState();
  const exists = state.projects.some((item) => item.id === id);
  if (!exists) return { ok: false, error: '项目不存在' };
  state.projects = state.projects.filter((item) => item.id !== id);
  store.saveState(state);
  return { ok: true };
}

/**
 * 更新项目基础信息
 * @param {string} id 项目 ID
 * @param {object} patch { name, note, accountId, remoteName }
 * @returns {{ok:boolean}}
 */
function update(id, patch) {
  const state = store.loadState();
  const index = state.projects.findIndex((item) => item.id === id);
  if (index < 0) return { ok: false, error: '项目不存在' };
  const next = Object.assign({}, state.projects[index], patch || {}, { updatedAt: new Date().toISOString() });
  state.projects.splice(index, 1, next);
  store.saveState(state);
  return { ok: true, project: next };
}

/**
 * 扫描目录下的 git 仓库（用于批量导入已有工程）
 * @param {object} options { rootDir, depth=3, maxResults=200 }
 * @returns {object}
 */
function scanRepos(options) {
  const rootDir = path.resolve(String(options.rootDir || ''));
  const depth = Math.max(1, Math.min(6, Number(options.depth) || 3));
  const maxResults = Number(options.maxResults) || 200;

  if (!rootDir || !fs.existsSync(rootDir)) return { ok: false, error: '扫描目录不存在：' + rootDir };

  const found = [];
  const ignored = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.idea', '.vscode', 'AppData']);

  /**
   * 递归遍历
   * @param {string} dir 当前目录
   * @param {number} level 当前层级
   */
  function walk(dir, level) {
    if (found.length >= maxResults) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }

    const hasGit = entries.some((entry) => entry.name === '.git');
    if (hasGit) {
      found.push({ path: dir, name: path.basename(dir) });
      // 仓库内部不再继续下钻，避免误入 submodule
      return;
    }
    if (level >= depth) return;

    entries
      .filter((entry) => entry.isDirectory() && !ignored.has(entry.name) && !entry.name.startsWith('.'))
      .forEach((entry) => {
        walk(path.join(dir, entry.name), level + 1);
      });
  }

  walk(rootDir, 0);

  const state = store.loadState();
  const known = new Set(state.projects.map((item) => path.resolve(item.path).toLowerCase()));

  const items = found.map((item) => ({
    path: item.path,
    name: item.name,
    alreadyAdded: known.has(path.resolve(item.path).toLowerCase())
  }));

  return { ok: true, rootDir: rootDir, depth: depth, items: items };
}

/**
 * 克隆仓库（自动把用户粘贴的地址改写为账号别名地址）
 * @param {object} payload { url, accountId, targetDir, folderName, remoteName }
 * @returns {Promise<object>}
 */
async function clone(payload) {
  const url = String((payload && payload.url) || '').trim();
  const targetDir = path.resolve(String((payload && payload.targetDir) || '').trim());
  if (!url) return { ok: false, error: '仓库地址不能为空' };
  if (!targetDir) return { ok: false, error: '目标目录不能为空' };
  if (!fs.existsSync(targetDir)) {
    return { ok: false, error: '目标目录不存在，请先创建或重新选择：' + targetDir };
  }

  const parsedUrl = parseRemoteUrl(url);
  if (parsedUrl.protocol === 'unknown') {
    return { ok: false, error: '无法识别仓库地址格式：' + url };
  }
  let repoPath = parsedUrl.path;

  let account = payload.accountId ? accounts.find(payload.accountId) : null;
  let autoMatchedBy = '';
  let finalUrl = url;

  if (!account && !payload.accountId && parsedUrl.protocol === 'ssh' && parsedUrl.host) {
    // 未显式指定账号时，按地址里的主机名自动认领账号：
    //   1) 地址里写的本来就是别名（git@git-yittiger:...）
    //   2) 地址写的是真实域名（git@github.com:...），且该域名只有一个账号
    // 这一步很关键：真实域名不做改写时，ssh 只会尝试默认 id_rsa，
    // 未注册到平台就会直接 Permission denied (publickey)。
    const hostLower = String(parsedUrl.host).toLowerCase();
    const byAlias = accounts.list().filter((item) => String(item.alias).toLowerCase() === hostLower);
    const byDomain = accounts.findAccountsByHostName(parsedUrl.host);

    if (byAlias.length === 1) {
      account = byAlias[0];
      autoMatchedBy = 'alias';
    } else if (byDomain.length === 1) {
      account = byDomain[0];
      autoMatchedBy = 'hostName';
    } else if (byDomain.length > 1) {
      return {
        ok: false,
        error: '域名 ' + parsedUrl.host + ' 下登记了 ' + byDomain.length + ' 个账号（' +
          byDomain.map((item) => item.label + '→' + item.alias).join('、') +
          '），请先在下拉框里选择用哪个账号，再改写为别名地址。'
      };
    }
  }

  if (account) {
    if (!repoPath) return { ok: false, error: '无法从地址中识别仓库路径' };
    finalUrl = buildAliasUrl(account, repoPath);
    if (String(parsedUrl.host).toLowerCase() === String(account.alias).toLowerCase()) {
      autoMatchedBy = autoMatchedBy || 'alias';
    }
  }

  const args = ['clone', finalUrl];
  const folderName = String((payload && payload.folderName) || '').trim();
  if (folderName) args.push(folderName);

  const result = await gitRunner.runGit(args, { cwd: targetDir, timeout: 300000 });
  if (!result.ok) {
    const rawError = result.error || (result.stderr + '\n' + result.stdout).trim();
    let hint = '';
    if (/Permission denied \(publickey/i.test(rawError)) {
      hint = account
        ? '（' + account.alias + ' 的私钥已发出但平台拒绝：请确认该公钥确实已添加到对应平台的 SSH Keys。）'
        : '（当前地址没有匹配到任何账号，ssh 只尝试了默认密钥 ~/.ssh/id_rsa。' +
          '请在克隆弹窗里选择账号，或先把地址改成别名形式 git@<别名>:owner/repo.git；' +
          '也可以在诊断页给该域名生成「域名兜底映射」。）';
    }
    return {
      ok: false,
      error: rawError + hint,
      url: finalUrl,
      command: result.command,
      accountAlias: account ? account.alias : '',
      autoMatchedBy: autoMatchedBy
    };
  }

  const clonedPath = path.join(targetDir, folderName || inferFolderName(repoPath));
  const addResult = add({ path: clonedPath, accountId: account ? account.id : '' });

  return {
    ok: true,
    url: finalUrl,
    path: clonedPath,
    accountAlias: account ? account.alias : '',
    autoMatchedBy: autoMatchedBy,
    projectAdded: addResult.ok,
    projectError: addResult.error || '',
    output: (result.stdout + result.stderr).trim()
  };
}

/**
 * 从仓库路径推断落盘目录名
 * @param {string} repoPath owner/repo.git
 * @returns {string}
 */
function inferFolderName(repoPath) {
  const base = String(repoPath || '').replace(/\/+$/, '').split('/').pop() || 'repo';
  return base.replace(/\.git$/i, '');
}

/**
 * 读取分支列表
 * @param {string} projectId 项目 ID
 * @returns {Promise<object>}
 */
async function getBranches(projectId) {
  const project = find(projectId);
  if (!project) return { ok: false, items: [], error: '项目不存在' };
  const result = await gitRunner.runGit(
    ['for-each-ref', '--format=%(refname:short)|%(objectname:short)|%(committerdate:format:%Y-%m-%d)', 'refs/heads', 'refs/remotes'],
    { cwd: project.path, timeout: 15000 }
  );
  if (!result.ok) return { ok: false, items: [], error: result.error || result.stderr.trim() };
  const items = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const parts = line.split('|');
      return { name: parts[0], hash: parts[1] || '', date: parts[2] || '', isRemote: parts[0].includes('/') };
    });
  return { ok: true, items: items };
}

/**
 * 读取提交历史
 * @param {string} projectId 项目 ID
 * @param {number} [count] 条数
 * @returns {Promise<object>}
 */
async function getLog(projectId, count) {
  const project = find(projectId);
  if (!project) return { ok: false, items: [], error: '项目不存在' };
  const limit = Math.max(1, Math.min(200, Number(count) || 20));
  const result = await gitRunner.runGit(
    ['log', '-' + limit, '--pretty=format:%h%x1f%an%x1f%ae%x1f%ad%x1f%s', '--date=format:%Y-%m-%d %H:%M'],
    { cwd: project.path, timeout: 15000 }
  );
  if (!result.ok) {
    return { ok: false, items: [], error: result.error || result.stderr.trim() || '仓库还没有提交记录' };
  }
  const items = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const f = line.split('\x1f');
      return { hash: f[0] || '', author: f[1] || '', email: f[2] || '', date: f[3] || '', subject: f[4] || '' };
    });
  return { ok: true, items: items };
}

/**
 * 动作 → git 参数映射（只允许白名单动作，避免任意命令执行）
 */
const ACTIONS = {
  fetch: () => ['fetch', '--all', '--prune'],
  pull: () => ['pull', '--no-edit'],
  push: () => ['push'],
  add: () => ['add', '-A'],
  status: () => ['status', '--short', '--branch'],
  restoreStaged: () => ['reset', 'HEAD'],
  stash: () => ['stash', 'push', '--include-untracked'],
  stashPop: () => ['stash', 'pop']
};

/**
 * 执行白名单内的 git 动作（流式输出由 IPC 层处理）
 * @param {string} projectId 项目 ID
 * @param {string} action 动作名
 * @param {object} [extra] { message, branch, remote, setUpstream }
 * @returns {{ok:boolean, args?:string[], cwd?:string, error?:string}}
 */
function buildActionArgs(projectId, action, extra) {
  const project = find(projectId);
  if (!project) return { ok: false, error: '项目不存在' };
  const payload = extra || {};

  let args = null;
  if (action === 'commit') {
    const message = String(payload.message || '').trim();
    if (!message) return { ok: false, error: '提交信息不能为空' };
    args = ['commit', '-m', message];
    if (payload.addAll !== false) args = ['commit', '-a', '-m', message];
  } else if (action === 'checkout') {
    const branch = String(payload.branch || '').trim();
    if (!branch || !/^[a-zA-Z0-9._\/-]+$/.test(branch)) return { ok: false, error: '分支名不合法' };
    args = ['checkout', branch];
  } else if (action === 'pushSetUpstream') {
    const branch = String(payload.branch || '').trim();
    if (!branch || !/^[a-zA-Z0-9._\/-]+$/.test(branch)) return { ok: false, error: '需要有效的当前分支名' };
    args = ['push', '--set-upstream', payload.remote || 'origin', branch];
  } else if (action === 'custom') {
    // 只允许只读类子命令，防止误操作破坏仓库
    const raw = Array.isArray(payload.args) ? payload.args.map((item) => String(item)) : [];
    const readonly = ['status', 'log', 'diff', 'show', 'remote', 'branch', 'config', 'rev-parse', 'describe', 'ls-files', 'blame', 'tag'];
    if (!raw.length || readonly.indexOf(raw[0]) < 0) {
      return { ok: false, error: '自定义命令仅允许只读子命令：' + readonly.join(' / ') };
    }
    args = raw;
  } else if (ACTIONS[action]) {
    args = ACTIONS[action]();
  } else {
    return { ok: false, error: '不支持的动作：' + action };
  }

  return { ok: true, args: args, cwd: project.path };
}

module.exports = {
  parseRemoteUrl,
  buildAliasUrl,
  isUsingAlias,
  previewBind,
  bind,
  getRemotes,
  getLocalIdentity,
  getGlobalIdentity,
  getRuntime,
  listWithStatus,
  find,
  add,
  remove,
  update,
  scanRepos,
  clone,
  getBranches,
  getLog,
  buildActionArgs,
  ACTIONS,
  inferFolderName
};
