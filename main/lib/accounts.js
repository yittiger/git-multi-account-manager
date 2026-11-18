'use strict';

/**
 * 账号与 SSH 密钥管理
 * ------------------------------------------------------------
 * 一个「账号」= 一套身份（SSH 私钥 + 提交用 user.name/email + 一个 Host 别名）。
 * 关键设计：别名必须与真实域名不同（例如 gitee-work），
 * 这样 git@gitee-work:owner/repo.git 才会强制走对应私钥，避免串号。
 * @author yittiger
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');
const paths = require('./paths');
const sshConfig = require('./sshConfig');
const gitRunner = require('./gitRunner');

 /** 平台预设：HostName 与 ssh 登录用户 */
const PROVIDERS = [
  { id: 'gitee', label: 'Gitee（码云）', hostName: 'gitee.com', sshUser: 'git' },
  { id: 'github', label: 'GitHub', hostName: 'github.com', sshUser: 'git' },
  { id: 'gitlab', label: 'GitLab', hostName: 'gitlab.com', sshUser: 'git' },
  { id: 'gitcode', label: 'GitCode', hostName: 'gitcode.com', sshUser: 'git' },
  { id: 'gitee-enterprise', label: 'Gitee 企业版', hostName: 'gitee.com', sshUser: 'git' },
  { id: 'custom', label: '自建 / 其它', hostName: '', sshUser: 'git' }
];

const KEY_TYPES = [
  { id: 'ed25519', label: 'ed25519（推荐，更短更安全）' },
  { id: 'rsa', label: 'RSA 4096（兼容性最好）' },
  { id: 'ecdsa', label: 'ECDSA 521' }
];

/**
 * 校验账号字段
 * @param {object} input 待校验数据
 * @param {object[]} existing 已有账号
 * @param {string} [selfId] 更新时排除自身
 * @returns {{ok:boolean, errors:object, value:object}}
 */
function validateAccount(input, existing, selfId) {
  const errors = {};
  const value = {
    label: String(input.label || '').trim(),
    provider: String(input.provider || 'custom').trim(),
    hostName: String(input.hostName || '').trim().toLowerCase(),
    port: Number(input.port) || 22,
    alias: String(input.alias || '').trim(),
    sshUser: String(input.sshUser || 'git').trim() || 'git',
    userName: String(input.userName || '').trim(),
    userEmail: String(input.userEmail || '').trim(),
    keyType: String(input.keyType || 'ed25519').trim(),
    keyPath: paths.expandPath(input.keyPath || ''),
    note: String(input.note || '').trim()
  };

  if (!value.label) errors.label = '账号名称不能为空';

  if (!value.hostName) {
    errors.hostName = '真实域名不能为空';
  } else if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(value.hostName)) {
    errors.hostName = '域名格式不合法，例如 gitee.com';
  }

  if (!value.alias) {
    errors.alias = 'SSH 别名不能为空';
  } else if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.alias)) {
    errors.alias = '别名只能用字母、数字、点、下划线、短横线，且不能以符号开头';
  } else if (value.alias.toLowerCase() === value.hostName.toLowerCase()) {
    errors.alias = '别名必须与真实域名不同，否则无法区分同域名的多个账号';
  } else if (value.alias.toLowerCase().startsWith('-')) {
    errors.alias = '别名不能以短横线开头，会被 ssh 当作参数';
  }

  if (!/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(value.userEmail)) {
    errors.userEmail = '提交邮箱格式不合法';
  }

  if (value.port < 1 || value.port > 65535) errors.port = '端口范围 1-65535';

  if (!errors.alias) {
    const duplicated = (existing || []).some(
      (item) => item.id !== selfId && String(item.alias).toLowerCase() === value.alias.toLowerCase()
    );
    if (duplicated) errors.alias = '该别名已被其它账号占用';
  }

  if (value.keyPath && /\.pub$/i.test(value.keyPath)) {
    // 用户误填公钥路径时，自动纠正为私钥路径
    value.keyPath = value.keyPath.replace(/\.pub$/i, '');
  }

  return { ok: Object.keys(errors).length === 0, errors, value };
}

/**
 * 规范化账号对象（补齐派生字段）
 * @param {object} value 校验后的字段
 * @param {string} id 账号 ID
 * @returns {object}
 */
function normalizeAccount(value, id) {
  const keyPath = value.keyPath || paths.defaultKeyPath(value.alias);
  return {
    id: id,
    label: value.label,
    provider: value.provider,
    hostName: value.hostName,
    port: value.port,
    alias: value.alias,
    sshUser: value.sshUser,
    userName: value.userName,
    userEmail: value.userEmail,
    keyType: value.keyType,
    keyPath: keyPath,
    keyComment: value.userEmail,
    // 写进 ssh config 的 IdentityFile，统一用 ~/ 形式
    identityFileHint: paths.toHomeRelative(keyPath),
    note: value.note,
    updatedAt: new Date().toISOString()
  };
}

/**
 * 列出所有账号
 * @returns {object[]}
 */
function list() {
  return store.loadState().accounts.slice();
}

/**
 * 按 ID 查找账号
 * @param {string} id 账号 ID
 * @returns {object|null}
 */
function find(id) {
  return store.loadState().accounts.find((item) => item.id === id) || null;
}

/**
 * 新建或更新账号
 * @param {object} payload 账号数据（含 id 表示更新）
 * @returns {{ok:boolean, errors?:object, account?:object}}
 */
function save(payload) {
  const state = store.loadState();
  const isUpdate = Boolean(payload && payload.id);
  const validation = validateAccount(payload || {}, state.accounts, isUpdate ? payload.id : null);

  if (!validation.ok) return { ok: false, errors: validation.errors };

  const id = isUpdate ? payload.id : store.createId('acc');
  const account = normalizeAccount(validation.value, id);
  account.createdAt = isUpdate
    ? ((find(id) || {}).createdAt || new Date().toISOString())
    : new Date().toISOString();

  // 载入已有状态用于展示
  account.keyExists = fs.existsSync(account.keyPath);
  account.pubExists = fs.existsSync(account.keyPath + '.pub');

  if (isUpdate) {
    const index = state.accounts.findIndex((item) => item.id === id);
    if (index < 0) return { ok: false, errors: { _: '账号不存在' } };
    state.accounts.splice(index, 1, account);
  } else {
    state.accounts.push(account);
  }

  store.saveState(state);
  return { ok: true, account: account };
}

/**
 * 删除账号
 * @param {string} id 账号 ID
 * @param {object} [options]
 * @param {boolean} [options.removeSshBlock] 是否从 ssh config 移除托管块，默认 true
 * @param {boolean} [options.keepKeyFiles] 是否保留密钥文件，默认 true（不误删用户资产）
 * @returns {{ok:boolean, detail:object}}
 */
function remove(id, options) {
  const opts = options || {};
  const state = store.loadState();
  const account = state.accounts.find((item) => item.id === id);
  if (!account) return { ok: false, error: '账号不存在' };

  const detail = { sshBlockRemoved: false, backupFile: null, keyFilesDeleted: [] };

  if (opts.removeSshBlock !== false) {
    const result = sshConfig.removeAccountBlock(account);
    detail.sshBlockRemoved = result.changed;
    detail.backupFile = result.backupFile;
    // 同时清掉该账号的域名兜底块，避免删号后残留无效映射
    const domainResult = sshConfig.removeDomainBlock(account);
    detail.domainBlockRemoved = domainResult.changed;
  }

  if (opts.keepKeyFiles === false) {
    [account.keyPath, account.keyPath + '.pub'].forEach((file) => {
      try {
        if (file && fs.existsSync(file)) {
          fs.unlinkSync(file);
          detail.keyFilesDeleted.push(file);
        }
      } catch (err) {
        detail.keyFilesDeleted.push('删除失败: ' + file);
      }
    });
  }

  state.accounts = state.accounts.filter((item) => item.id !== id);
  store.saveState(state);
  return { ok: true, detail: detail };
}

/**
 * 生成 SSH 密钥对
 * @param {string} id 账号 ID
 * @param {object} [options]
 * @param {boolean} [options.force] 已存在时是否覆盖（旧文件改名为 .bak）
 * @returns {Promise<{ok:boolean, account?:object, publicKey?:string, error?:string, forced?:boolean}>}
 */
async function generateKey(id, options) {
  const opts = options || {};
  const account = find(id);
  if (!account) return { ok: false, error: '账号不存在' };

  const keyPath = account.keyPath || paths.defaultKeyPath(account.alias);
  paths.ensureDir(path.dirname(keyPath));

  let forced = false;
  if (fs.existsSync(keyPath)) {
    if (!opts.force) {
      return {
        ok: false,
        error: '私钥已存在：' + keyPath + '（如需覆盖请勾选「覆盖已有密钥」）'
      };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = keyPath + '.bak-' + stamp;
    fs.renameSync(keyPath, backup);
    if (fs.existsSync(keyPath + '.pub')) {
      fs.renameSync(keyPath + '.pub', backup + '.pub');
    }
    forced = true;
  }

  const keyType = account.keyType === 'rsa' ? 'rsa' : account.keyType === 'ecdsa' ? 'ecdsa' : 'ed25519';
  const args = [
    '-t', keyType,
    '-C', account.userEmail || account.alias,
    '-f', keyPath,
    '-N', '',
    '-q'
  ];
  if (keyType === 'rsa') args.push('-b', '4096');
  if (keyType === 'ecdsa') args.push('-b', '521');

  const result = await gitRunner.runKeygen(args, { timeout: 20000 });
  if (!result.ok && !fs.existsSync(keyPath)) {
    return { ok: false, error: result.error || result.stderr.trim() || '密钥生成失败' };
  }

  // 生成成功后同步密钥路径到账号记录
  const state = store.loadState();
  const index = state.accounts.findIndex((item) => item.id === id);
  if (index >= 0) {
    state.accounts[index].keyPath = keyPath;
    state.accounts[index].identityFileHint = paths.toHomeRelative(keyPath);
    state.accounts[index].updatedAt = new Date().toISOString();
    store.saveState(state);
  }

  const publicKey = readPublicKey(id);
  return { ok: true, account: find(id), publicKey: publicKey.value || '', forced: forced };
}

/**
 * 读取公钥内容
 * @param {string} id 账号 ID
 * @returns {{ok:boolean, value?:string, error?:string, file?:string}}
 */
function readPublicKey(id) {
  const account = find(id);
  if (!account) return { ok: false, error: '账号不存在' };
  const file = account.keyPath + '.pub';
  if (!fs.existsSync(file)) {
    return { ok: false, error: '公钥文件不存在：' + file, file: file };
  }
  return { ok: true, value: fs.readFileSync(file, 'utf8').trim(), file: file };
}

/**
 * 预览将写入 ssh config 的内容
 * @param {string} id 账号 ID
 * @returns {{ok:boolean, block?:string, inspect?:object}}
 */
function previewBlock(id) {
  const account = find(id);
  if (!account) return { ok: false, error: '账号不存在' };
  return {
    ok: true,
    block: sshConfig.buildHostBlock(account),
    inspect: sshConfig.inspectAccountBlock(account)
  };
}

/**
 * 把账号写入 ~/.ssh/config
 * @param {string} id 账号 ID
 * @returns {object} { ok, changed, backupFile, configFile, block }
 */
function applySshConfig(id) {
  const account = find(id);
  if (!account) return { ok: false, error: '账号不存在' };
  const result = sshConfig.upsertAccountBlock(account);
  return Object.assign({ ok: true }, result);
}

/**
 * 批量写入全部账号配置
 * @returns {object[]} 每个账号的结果
 */
function applyAllSshConfig() {
  const results = [];
  list().forEach((account) => {
    const result = sshConfig.upsertAccountBlock(account);
    results.push({
      id: account.id,
      label: account.label,
      alias: account.alias,
      changed: result.changed,
      error: result.error || ''
    });
  });
  return results;
}

/**
 * 按真实域名找出所有账号
 * @param {string} hostName 真实域名，例如 github.com
 * @returns {object[]}
 */
function findAccountsByHostName(hostName) {
  const target = String(hostName || '').trim().toLowerCase();
  if (!target) return [];
  return list().filter((account) => String(account.hostName || '').toLowerCase() === target);
}

/**
 * 写入「真实域名兜底映射」
 * ------------------------------------------------------------
 * 作用是让 git@github.com:owner/repo.git 这种裸域名地址
 * 也直接使用该账号的私钥，不再依赖 ssh-agent 或默认 id_rsa。
 * 同一域名下有多个账号时无法确定用谁，直接拒绝。
 * @param {string} id 账号 ID
 * @returns {{ok:boolean, error?:string, detail?:object}}
 */
function applyDomainMapping(id) {
  const account = find(id);
  if (!account) return { ok: false, error: '账号不存在' };

  const candidates = findAccountsByHostName(account.hostName);
  if (candidates.length > 1) {
    return {
      ok: false,
      error: '域名 ' + account.hostName + ' 下存在 ' + candidates.length + ' 个账号（' +
        candidates.map((item) => item.alias).join('、') +
        '），无法为裸域名确定唯一身份。请克隆/绑定时使用别名地址 git@' + account.alias + ':owner/repo.git。'
    };
  }

  const result = sshConfig.upsertDomainBlock(account);
  if (!result.ok) return { ok: false, error: result.conflict };
  return { ok: true, detail: result };
}

/**
 * 移除「真实域名兜底映射」
 * @param {string} id 账号 ID
 * @returns {{ok:boolean, detail?:object}}
 */
function removeDomainMapping(id) {
  const account = find(id);
  if (!account) return { ok: false, error: '账号不存在' };
  const result = sshConfig.removeDomainBlock(account);
  return { ok: true, detail: result };
}

/**
 * 测试账号 SSH 连通性
 * @param {string} id 账号 ID
 * @returns {Promise<object>} { ok, level, message, raw, command, duration }
 */
async function testConnection(id) {
  const account = find(id);
  if (!account) return { ok: false, level: 'error', message: '账号不存在' };

  const inspect = sshConfig.inspectAccountBlock(account);
  if (!inspect.present) {
    return {
      ok: false,
      level: 'error',
      message: 'SSH 配置里还没有别名 ' + account.alias + '，请先点「写入 SSH 配置」',
      raw: '',
      duration: 0
    };
  }

  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=8',
    account.alias
  ];

  const result = await gitRunner.runSsh(args, { timeout: 20000 });
  const raw = (result.stdout + '\n' + result.stderr).trim();

  if (result.error) {
    return { ok: false, level: 'error', message: result.error, raw: raw, duration: result.duration, command: result.command };
  }

  // GitHub / Gitee / GitLab 认证成功时退出码通常为 1，但会打印认证成功文案
  const successPattern = /successfully authenticated|Hi\s+\S+!|Welcome to GitLab|You've successfully/i;
  if (successPattern.test(raw)) {
    return { ok: true, level: 'ok', message: '连通正常：' + firstLine(raw), raw: raw, duration: result.duration, command: result.command };
  }

  if (/Permission denied \(publickey/i.test(raw)) {
    return {
      ok: false,
      level: 'error',
      message: '私钥已发出但平台拒绝：公钥还没添加到该账号的 SSH Keys',
      raw: raw,
      duration: result.duration,
      command: result.command
    };
  }
  if (/Could not resolve hostname/i.test(raw)) {
    return {
      ok: false,
      level: 'error',
      message: '别名未解析：ssh config 可能没写成功，或 Host 名称拼错',
      raw: raw,
      duration: result.duration,
      command: result.command
    };
  }
  if (/timed out|Connection refused|No route to host/i.test(raw)) {
    return {
      ok: false,
      level: 'error',
      message: '网络不通：检查代理 / 防火墙 / 是否用了 22 端口',
      raw: raw,
      duration: result.duration,
      command: result.command
    };
  }

  if (result.timedOut) {
    return { ok: false, level: 'error', message: '连接超时（20s），可能是网络或代理问题', raw: raw, duration: result.duration };
  }

  return {
    ok: result.ok,
    level: result.ok ? 'ok' : 'warn',
    message: result.ok ? '连通正常' : ('未识别的返回：' + firstLine(raw || '无输出')),
    raw: raw,
    duration: result.duration,
    command: result.command
  };
}

/**
 * 取第一行非空文本
 * @param {string} text 文本
 * @returns {string}
 */
function firstLine(text) {
  const line = String(text || '').split(/\r?\n/).find((item) => item.trim().length);
  return line ? line.trim() : '';
}

/**
 * 扫描 ~/.ssh 下已有的密钥对
 * @returns {object[]} [{ privateKey, publicKey, bits, type, fingerprint }]
 */
function listLocalKeys() {
  const dir = paths.SSH_DIR;
  const result = [];
  if (!fs.existsSync(dir)) return result;

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return result;
  }

  entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.pub') && !entry.name.startsWith('known_hosts'))
    .filter((entry) => !entry.name.endsWith('.bak') && entry.name !== 'config')
    .forEach((entry) => {
      const privateKey = path.join(dir, entry.name);
      const publicKey = privateKey + '.pub';
      let head = '';
      try {
        head = fs.readFileSync(privateKey, 'utf8').slice(0, 80);
      } catch (err) {
        return;
      }
      if (!/PRIVATE KEY/.test(head)) return;

      let type = 'unknown';
      if (/BEGIN OPENSSH PRIVATE KEY/.test(head)) type = 'openssh';
      else if (/BEGIN RSA/.test(head)) type = 'rsa';
      else if (/BEGIN EC/.test(head)) type = 'ecdsa';

      result.push({
        name: entry.name,
        privateKey: privateKey,
        publicKey: fs.existsSync(publicKey) ? publicKey : '',
        hasPublic: fs.existsSync(publicKey),
        type: type,
        size: fs.statSync(privateKey).size
      });
    });

  return result;
}

/**
 * 账号列表 + 实时状态（供界面渲染）
 * @returns {object[]}
 */
function listWithStatus() {
  return list().map((account) => {
    const inspect = sshConfig.inspectAccountBlock(account);
    const domainInspect = sshConfig.inspectDomainBlock(account);
    const keyExists = fs.existsSync(account.keyPath || '');
    const pubExists = fs.existsSync((account.keyPath || '') + '.pub');
    let publicKeyType = '';
    let publicKeyFingerprintHint = '';
    if (pubExists) {
      try {
        const content = fs.readFileSync(account.keyPath + '.pub', 'utf8').trim();
        publicKeyType = content.split(/\s+/)[0] || '';
        publicKeyFingerprintHint = content.slice(0, 24) + '…';
      } catch (err) {
        /* 忽略读取失败 */
      }
    }
    return Object.assign({}, account, {
      keyExists: keyExists,
      pubExists: pubExists,
      publicKeyType: publicKeyType,
      publicKeyFingerprintHint: publicKeyFingerprintHint,
      sshConfigPresent: inspect.present,
      sshConfigConsistent: inspect.consistent,
      domainMappingPresent: domainInspect.present,
      domainMappingConsistent: domainInspect.consistent
    });
  });
}

module.exports = {
  PROVIDERS,
  KEY_TYPES,
  validateAccount,
  list,
  listWithStatus,
  find,
  save,
  remove,
  generateKey,
  readPublicKey,
  previewBlock,
  applySshConfig,
  applyAllSshConfig,
  findAccountsByHostName,
  applyDomainMapping,
  removeDomainMapping,
  testConnection,
  listLocalKeys
};
