'use strict';

/**
 * ~/.ssh/config 解析与块级增删改
 * ------------------------------------------------------------
 * 只做「按 Host 块」的增删改，其余内容（注释、Match、未托管的主机）
 * 原样保留，绝不整体重写 —— 这是多账号方案里最容易踩坑的地方，
 * 一旦把用户已有配置覆盖掉，其他仓库的推拉就全挂了。
 * @author yittiger
 */

const fs = require('fs');
const path = require('path');
const { SSH_CONFIG_FILE, SSH_DIR, ensureDir, readFileSafe } = require('./paths');

const MARKER_PREFIX = '# git-tools:account=';

/**
 * 域名兜底块的标记前缀。
 * ------------------------------------------------------------
 * 别名块（Host gitee-work）只有在 URL 里写了别名时才生效；
 * 而用户从网页复制的地址、第三方工具、已 clone 的老仓库
 * 用的都是真实域名（github.com / gitee.com），此时 ssh 只会
 * 尝试 ~/.ssh/id_rsa 等默认身份 → Permission denied (publickey)。
 * 因此对「该域名下只有一个账号」的情况，额外写一个真实域名的
 * 兜底块，让裸域名也能直接用对私钥（不必依赖 ssh-agent）。
 */
const DOMAIN_MARKER_PREFIX = '# git-tools:domain=';

/**
 * 把 config 文本按 Host/Match 块切分
 * @param {string} text 原始配置
 * @returns {{preamble:string[], blocks:Array<{header:string,hosts:string[],lines:string[]}>}}
 */
function splitBlocks(text) {
  const lines = String(text || '').split(/\r?\n/);
  const preamble = [];
  const blocks = [];
  let current = null;

  lines.forEach((line) => {
    // Host / Match 必须出现在行首（允许前置空格），值里出现的同名词不算块头
    if (/^\s*(Host|Match)\s+/i.test(line)) {
      if (current) blocks.push(current);
      const keyword = line.trim().split(/\s+/)[0].toLowerCase();
      const value = line.trim().slice(line.trim().indexOf(' ') + 1).trim();
      current = {
        header: line.trim(),
        keyword,
        hosts: keyword === 'host' ? value.split(/\s+/).map((h) => h.toLowerCase()) : [],
        lines: [line]
      };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  });
  if (current) blocks.push(current);

  return { preamble, blocks };
}

/**
 * 去掉块尾部多余空行，便于拼接
 * @param {string[]} lines 块内容
 * @returns {string[]}
 */
function trimTrailingBlank(lines) {
  const copy = lines.slice();
  while (copy.length && copy[copy.length - 1].trim() === '') copy.pop();
  return copy;
}

/**
 * 组装 Host 块文本
 * @param {object} account 账号对象
 * @returns {string}
 */
function buildHostBlock(account) {
  const indent = '  ';
  // 标记行放在 Host 之后、块内部：这样重新解析时它仍属于本块，
  // 不会被并入上一个 Host 块（否则按标记定位会找错块）。
  const lines = [
    'Host ' + account.alias,
    indent + MARKER_PREFIX + account.id + ' (' + (account.label || account.alias) + ')',
    indent + 'HostName ' + account.hostName,
    indent + 'User ' + (account.sshUser || 'git'),
    indent + 'IdentityFile ' + (account.identityFileHint || ('~/.ssh/' + account.alias)),
    indent + 'IdentitiesOnly yes'
  ];
  if (account.port && Number(account.port) !== 22) {
    lines.splice(2, 0, indent + 'Port ' + account.port);
  }
  return lines.join('\n');
}

/**
 * 组装「真实域名兜底块」文本
 * ------------------------------------------------------------
 * Host 用真实域名，其余字段与别名块一致。
 * 注意：该块会改变裸域名请求的默认身份，只应对
 * 「该域名下只有一个账号」的情况使用。
 * @param {object} account 账号对象
 * @returns {string}
 */
function buildDomainBlock(account) {
  const indent = '  ';
  const lines = [
    'Host ' + account.hostName,
    indent + DOMAIN_MARKER_PREFIX + account.id + ' (' + (account.label || account.alias) + ')',
    indent + 'HostName ' + account.hostName,
    indent + 'User ' + (account.sshUser || 'git'),
    indent + 'IdentityFile ' + (account.identityFileHint || ('~/.ssh/' + account.alias)),
    indent + 'IdentitiesOnly yes'
  ];
  if (account.port && Number(account.port) !== 22) {
    lines.splice(2, 0, indent + 'Port ' + account.port);
  }
  return lines.join('\n');
}

/**
 * 在文本中查找「真实域名兜底块」
 * @param {object} parsed splitBlocks 结果
 * @param {object} account 账号对象
 * @returns {{index:number, owned:boolean}} index 为 -1 表示没有该块；owned 表示是否本工具写入
 */
function findDomainBlock(parsed, account) {
  const hostNameLower = String(account.hostName || '').toLowerCase();
  const markerId = DOMAIN_MARKER_PREFIX + account.id;

  const byMarker = parsed.blocks.findIndex((block) =>
    block.lines.some((line) => line.trim().indexOf(markerId) === 0)
  );
  if (byMarker >= 0) return { index: byMarker, owned: true };

  const byHost = parsed.blocks.findIndex((block) =>
    block.keyword === 'host' && block.hosts.indexOf(hostNameLower) >= 0
  );
  if (byHost >= 0) return { index: byHost, owned: false };

  return { index: -1, owned: false };
}

/**
 * 写入/更新真实域名兜底块
 * ------------------------------------------------------------
 * 已经存在「非本工具写入」的同名 Host 块时直接拒绝，
 * 绝不覆盖用户自己的配置。
 * @param {object} account 账号对象
 * @returns {{ok:boolean, changed:boolean, conflict:string, configFile:string, backupFile:string|null, block:string}}
 */
function upsertDomainBlock(account) {
  if (!account || !account.hostName) {
    return { ok: false, changed: false, conflict: '账号缺少真实域名，无法生成域名兜底块', block: '' };
  }

  ensureDir(SSH_DIR);
  const original = readFileSafe(SSH_CONFIG_FILE) || '';
  const parsed = splitBlocks(original);
  const found = findDomainBlock(parsed, account);
  const blockText = buildDomainBlock(account);

  if (found.index >= 0 && !found.owned) {
    return {
      ok: false,
      changed: false,
      conflict: '~/.ssh/config 里已存在你手写的 Host ' + account.hostName +
        ' 块，本工具不会覆盖。请先手动确认或删除该块后重试。',
      configFile: SSH_CONFIG_FILE,
      backupFile: null,
      block: blockText
    };
  }

  if (found.index >= 0) {
    parsed.blocks[found.index].lines = blockText.split('\n');
  } else {
    // 追加到末尾：别名块先匹配，域名块只兜底裸域名请求
    parsed.blocks.push({
      header: 'Host ' + account.hostName,
      keyword: 'host',
      hosts: [String(account.hostName).toLowerCase()],
      lines: blockText.split('\n')
    });
  }

  const segments = [];
  const preambleLines = trimTrailingBlank(parsed.preamble);
  if (preambleLines.length) segments.push(preambleLines.join('\n'));
  parsed.blocks.forEach((block) => segments.push(trimTrailingBlank(block.lines).join('\n')));

  let nextText = segments.join('\n\n');
  if (!nextText.endsWith('\n')) nextText += '\n';

  const changed = nextText !== original;
  let backupFile = null;
  if (changed) {
    if (original) {
      backupFile = SSH_CONFIG_FILE + '.git-tools.bak';
      fs.writeFileSync(backupFile, original, 'utf8');
    }
    fs.writeFileSync(SSH_CONFIG_FILE, nextText, 'utf8');
  }

  return { ok: true, changed: changed, conflict: '', configFile: SSH_CONFIG_FILE, backupFile: backupFile, block: blockText };
}

/**
 * 移除真实域名兜底块（只删本工具写入且属于该账号的块）
 * @param {object} account 账号对象
 * @returns {{ok:boolean, changed:boolean, configFile:string, backupFile:string|null}}
 */
function removeDomainBlock(account) {
  const original = readFileSafe(SSH_CONFIG_FILE);
  if (!original || !account) return { ok: true, changed: false, configFile: SSH_CONFIG_FILE, backupFile: null };

  const parsed = splitBlocks(original);
  const found = findDomainBlock(parsed, account);
  if (found.index < 0 || !found.owned) {
    return { ok: true, changed: false, configFile: SSH_CONFIG_FILE, backupFile: null };
  }

  parsed.blocks.splice(found.index, 1);

  const segments = [];
  const preambleLines = trimTrailingBlank(parsed.preamble);
  if (preambleLines.length) segments.push(preambleLines.join('\n'));
  parsed.blocks.forEach((block) => segments.push(trimTrailingBlank(block.lines).join('\n')));

  let nextText = segments.join('\n\n');
  if (!nextText.endsWith('\n')) nextText += '\n';

  const backupFile = SSH_CONFIG_FILE + '.git-tools.bak';
  fs.writeFileSync(backupFile, original, 'utf8');
  fs.writeFileSync(SSH_CONFIG_FILE, nextText, 'utf8');

  return { ok: true, changed: true, configFile: SSH_CONFIG_FILE, backupFile: backupFile };
}

/**
 * 检查真实域名兜底块是否存在且内容一致
 * @param {object} account 账号对象
 * @returns {{present:boolean, owned:boolean, consistent:boolean, block:string, hostName:string}}
 */
function inspectDomainBlock(account) {
  const original = readFileSafe(SSH_CONFIG_FILE) || '';
  const parsed = splitBlocks(original);
  const found = findDomainBlock(parsed, account);
  if (found.index < 0) {
    return { present: false, owned: false, consistent: false, block: '', hostName: account.hostName };
  }
  const blockText = parsed.blocks[found.index].lines.join('\n');
  const hasHostName = new RegExp('^\\s*HostName\\s+' + escapeRegExp(account.hostName) + '\\s*$', 'im').test(blockText);
  const hasIdentity = new RegExp('^\\s*IdentityFile\\s+' + escapeRegExp(account.identityFileHint || '') + '\\s*$', 'im').test(blockText);
  const hasIdentitiesOnly = /^\s*IdentitiesOnly\s+yes\s*$/im.test(blockText);
  return {
    present: true,
    owned: found.owned,
    consistent: hasHostName && hasIdentity && hasIdentitiesOnly,
    block: blockText,
    hostName: account.hostName
  };
}

/**
 * 在文本中查找与别名或账号 ID 对应的块
 * @param {object} parsed splitBlocks 结果
 * @param {string} alias 别名
 * @param {string} [accountId] 账号 ID
 * @returns {number} 块索引，未找到返回 -1
 */
function findBlockIndex(parsed, alias, accountId) {
  const aliasLower = String(alias || '').toLowerCase();
  const markerId = accountId ? MARKER_PREFIX + accountId : '';

  // 先按账号 ID 标记匹配（改名场景也能准确定位旧块）
  if (markerId) {
    const byMarker = parsed.blocks.findIndex((block) =>
      block.lines.some((line) => line.trim().indexOf(markerId) === 0)
    );
    if (byMarker >= 0) return byMarker;
  }

  // 再按 Host 名匹配（精确匹配，Host * 通配不算）
  return parsed.blocks.findIndex((block) =>
    block.keyword === 'host' && block.hosts.indexOf(aliasLower) >= 0
  );
}

/**
 * 写入/更新账号对应的 Host 块
 * @param {object} account 账号对象
 * @returns {{changed:boolean, configFile:string, backupFile:string|null, block:string}}
 */
function upsertAccountBlock(account) {
  ensureDir(SSH_DIR);
  const original = readFileSafe(SSH_CONFIG_FILE) || '';
  const parsed = splitBlocks(original);
  const index = findBlockIndex(parsed, account.alias, account.id);
  const blockText = buildHostBlock(account);

  if (index >= 0) {
    // 用新块替换旧块（含标记行）
    parsed.blocks[index].lines = blockText.split('\n');
  } else {
    parsed.blocks.push({ header: 'Host ' + account.alias, keyword: 'host', hosts: [String(account.alias).toLowerCase()], lines: blockText.split('\n') });
  }

  const segments = [];
  const preambleLines = trimTrailingBlank(parsed.preamble);
  if (preambleLines.length) segments.push(preambleLines.join('\n'));
  parsed.blocks.forEach((block) => {
    segments.push(trimTrailingBlank(block.lines).join('\n'));
  });

  let nextText = segments.join('\n\n');
  if (!nextText.endsWith('\n')) nextText += '\n';

  const changed = nextText !== original;
  let backupFile = null;
  if (changed) {
    if (original) {
      backupFile = SSH_CONFIG_FILE + '.git-tools.bak';
      fs.writeFileSync(backupFile, original, 'utf8');
    }
    fs.writeFileSync(SSH_CONFIG_FILE, nextText, 'utf8');
  }

  return { changed, configFile: SSH_CONFIG_FILE, backupFile, block: blockText };
}

/**
 * 从 config 中移除账号对应的块
 * @param {object} account 账号对象
 * @returns {{changed:boolean, configFile:string, backupFile:string|null}}
 */
function removeAccountBlock(account) {
  const original = readFileSafe(SSH_CONFIG_FILE);
  if (!original) return { changed: false, configFile: SSH_CONFIG_FILE, backupFile: null };

  const parsed = splitBlocks(original);
  const index = findBlockIndex(parsed, account.alias, account.id);
  if (index < 0) return { changed: false, configFile: SSH_CONFIG_FILE, backupFile: null };

  parsed.blocks.splice(index, 1);

  const segments = [];
  const preambleLines = trimTrailingBlank(parsed.preamble);
  if (preambleLines.length) segments.push(preambleLines.join('\n'));
  parsed.blocks.forEach((block) => segments.push(trimTrailingBlank(block.lines).join('\n')));

  let nextText = segments.join('\n\n');
  if (!nextText.endsWith('\n')) nextText += '\n';

  const backupFile = SSH_CONFIG_FILE + '.git-tools.bak';
  fs.writeFileSync(backupFile, original, 'utf8');
  fs.writeFileSync(SSH_CONFIG_FILE, nextText, 'utf8');

  return { changed: true, configFile: SSH_CONFIG_FILE, backupFile };
}

/**
 * 检查账号块是否已写入且内容与当前账号一致
 * @param {object} account 账号对象
 * @returns {{present:boolean, consistent:boolean, hosts:string[], block:string}}
 */
function inspectAccountBlock(account) {
  const original = readFileSafe(SSH_CONFIG_FILE) || '';
  const parsed = splitBlocks(original);
  const index = findBlockIndex(parsed, account.alias, account.id);
  if (index < 0) {
    return { present: false, consistent: false, hosts: [], block: '' };
  }
  const blockText = parsed.blocks[index].lines.join('\n');
  const hosts = parsed.blocks[index].hosts;
  const hasHostName = new RegExp('^\\s*HostName\\s+' + escapeRegExp(account.hostName) + '\\s*$', 'im').test(blockText);
  const hasIdentity = /^\s*IdentityFile\s+/im.test(blockText);
  const hasIdentitiesOnly = /^\s*IdentitiesOnly\s+yes\s*$/im.test(blockText);
  return {
    present: true,
    consistent: hasHostName && hasIdentity && hasIdentitiesOnly,
    hosts,
    block: blockText
  };
}

/**
 * 列出所有 Host 别名（用于诊断重复别名）
 * @returns {string[]}
 */
function listConfiguredHosts() {
  const original = readFileSafe(SSH_CONFIG_FILE) || '';
  const parsed = splitBlocks(original);
  const result = [];
  parsed.blocks.forEach((block) => {
    if (block.keyword === 'host') block.hosts.forEach((h) => result.push(h));
  });
  return result;
}

/**
 * 让某个主机名强制走指定别名（可选能力：把裸域名请求转发到托管别名）
 * 由于会影响其它工具的默认行为，这里仅提供查询，不自动写入。
 * @param {string} hostName 真实域名
 * @returns {string[]} 第一个匹配该 HostName 的别名
 */
function findAliasesByHostName(hostName) {
  const original = readFileSafe(SSH_CONFIG_FILE) || '';
  const parsed = splitBlocks(original);
  const result = [];
  parsed.blocks.forEach((block) => {
    if (block.keyword !== 'host') return;
    const text = block.lines.join('\n');
    if (new RegExp('^\\s*HostName\\s+' + escapeRegExp(hostName) + '\\s*$', 'im').test(text)) {
      block.hosts.forEach((h) => result.push(h));
    }
  });
  return result;
}

/**
 * 转义正则元字符
 * @param {string} str 原字符串
 * @returns {string}
 */
function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  MARKER_PREFIX,
  DOMAIN_MARKER_PREFIX,
  splitBlocks,
  buildHostBlock,
  buildDomainBlock,
  upsertAccountBlock,
  upsertDomainBlock,
  removeAccountBlock,
  removeDomainBlock,
  inspectAccountBlock,
  inspectDomainBlock,
  listConfiguredHosts,
  findAliasesByHostName,
  CONFIG_FILE: SSH_CONFIG_FILE
};
