'use strict';

/**
 * 配置诊断
 * ------------------------------------------------------------
 * 把「多个账号在一台机器上互相串号」的典型成因逐条检查出来，
 * 并对可自动修复的问题给出修复入口（fix）。
 * 检查维度：环境 → 全局配置 → 各账号 → 各项目。
 * @author yittiger
 */

const fs = require('fs');
const store = require('./store');
const gitRunner = require('./gitRunner');
const accounts = require('./accounts');
const projects = require('./projects');
const sshConfig = require('./sshConfig');
const sshClient = require('./sshClient');

/**
 * 构造一条诊断结果
 * @param {object} payload 字段
 * @returns {object}
 */
function item(payload) {
  return Object.assign({
    id: '',
    scope: 'env',
    targetId: '',
    targetLabel: '',
    level: 'info',
    title: '',
    detail: '',
    fix: null
  }, payload);
}

/**
 * 执行完整诊断
 * @param {object} [options]
 * @param {boolean} [options.testConnections] 是否逐个测试 SSH 连通性（耗时较长）
 * @returns {Promise<object>}
 */
async function run(options) {
  const opts = options || {};
  const state = store.loadState();
  const items = [];

  // ---------- 1. 环境 ----------
  const versions = await gitRunner.probeVersions();

  if (!versions.git.available) {
    items.push(item({
      scope: 'env',
      level: 'error',
      title: '未检测到可用的 Git',
      detail: versions.git.error + (versions.git.path ? '（路径：' + versions.git.path + '）' : '') +
        '。安装 Git for Windows，或在「设置」中手动指定 git.exe 路径。',
      fix: { action: 'openSettings', label: '去设置路径' }
    }));
  } else {
    items.push(item({ scope: 'env', level: 'ok', title: 'Git 可用', detail: versions.git.version + '（' + versions.git.path + '）' }));
  }

  if (!versions.ssh.available) {
    items.push(item({
      scope: 'env',
      level: 'error',
      title: '未检测到可用的 ssh',
      detail: versions.ssh.error + '。在 Windows「可选功能」中启用 OpenSSH 客户端，或在「设置」中指定 ssh.exe。',
      fix: { action: 'openSettings', label: '去设置路径' }
    }));
  } else {
    items.push(item({ scope: 'env', level: 'ok', title: 'ssh 可用', detail: versions.ssh.version }));
  }

  // SSH 客户端实现：OpenSSH 才认 ~/.ssh/config，plink 不认
  const sshClientInfo = sshClient.detect();
  if (sshClientInfo.plinkSources.length) {
    const firstAccount = accounts.list()[0];
    const plan = firstAccount ? sshClient.buildPlinkPlan(firstAccount) : null;
    const where = sshClientInfo.plinkSources.map((item) => item.key + ' = ' + item.value).join('；');
    const compatLines = plan
      ? [
          '若必须继续用 plink（例如团队统一用 Pageant），只能走兼容方案：',
          '1) 私钥转 ppk：' + plan.convertCommand,
          '2) 仓库级指定：' + plan.sshCommand,
          '3) remote 写回真实域名（不能用别名地址）'
        ].join('\n')
      : '';
    items.push(item({
      scope: 'env',
      level: sshClientInfo.guiPlink && sshClientInfo.effective.kind !== 'plink' ? 'warn' : 'error',
      title: 'Git 客户端使用 PuTTY/plink，别名地址会失效',
      detail: '检测到 ' + where + '。plink 不读取 ~/.ssh/config，' +
        'git@别名:owner/repo.git 会报 “Unable to open connection: Host does not exist”，' +
        'IdentityFile / IdentitiesOnly 也全部不生效。切换到 OpenSSH 即可恢复别名机制。\n' + compatLines,
      fix: sshClientInfo.openSshPath
        ? { action: 'switchSshClient', label: '切换 TortoiseGit 到 OpenSSH' }
        : null
    }));
  }
  if (!sshClientInfo.ok && sshClientInfo.effective.kind === 'plink') {
    items.push(item({
      scope: 'env',
      level: 'error',
      title: '命令行 git 的 ssh 被环境变量/全局配置指定为 plink',
      detail: '生效来源：' + sshClientInfo.effective.key + ' = ' + sshClientInfo.effective.value +
        '。该项无法由本工具修改（属于环境变量或全局 git 配置），请手动改为 OpenSSH，或执行：' +
        'git config --global --unset core.sshCommand（若来源是 core.sshCommand）。'
    }));
  } else if (sshClientInfo.ok) {
    items.push(item({
      scope: 'env',
      level: 'ok',
      title: 'SSH 客户端为 OpenSSH',
      detail: '生效来源：' + sshClientInfo.effective.key + ' → ' + (sshClientInfo.effective.value || '未探测到') +
        '，别名与 IdentityFile 正常生效。'
    }));
  }

  if (!versions.sshKeygen.available) {
    items.push(item({
      scope: 'env',
      level: 'warn',
      title: '缺少 ssh-keygen',
      detail: '无法在应用内生成密钥；可手动用 Git Bash 生成后在此登记。',
      fix: { action: 'openSettings', label: '去设置路径' }
    }));
  }

  // ---------- 2. 全局提交身份 ----------
  const global = await projects.getGlobalIdentity();
  if (global.name || global.email) {
    items.push(item({
      scope: 'global',
      level: 'warn',
      title: '存在全局 git 提交身份',
      detail: 'global 配置为 ' + (global.name || '(空)') + ' <' + (global.email || '(空)') + '>。' +
        '多账号场景下全局身份容易被误用，各仓库应显式设置本地身份（本项目「绑定账号」会自动写入 local）。',
      fix: null
    }));
  } else {
    items.push(item({
      scope: 'global',
      level: 'ok',
      title: '全局未设置提交身份',
      detail: '不会出现全局身份覆盖各仓库本地身份的情况。'
    }));
  }

  // 别名重复检查（配置文件里手工堆出来的重复别名）
  const configuredHosts = sshConfig.listConfiguredHosts();
  const duplicateHosts = configuredHosts.filter((host, index) => configuredHosts.indexOf(host) !== index);
  if (duplicateHosts.length) {
    items.push(item({
      scope: 'global',
      level: 'error',
      title: 'ssh config 中存在重复 Host 别名',
      detail: '重复别名：' + Array.from(new Set(duplicateHosts)).join('、') + '。重复时 ssh 只认第一个匹配块，后写的不生效。',
      fix: { action: 'applyAllSshConfig', label: '按账号重写托管块' }
    }));
  }

  // ---------- 3. 账号 ----------
  const accountList = accounts.list();
  if (!accountList.length) {
    items.push(item({
      scope: 'account',
      level: 'info',
      title: '还没有登记任何账号',
      detail: '先在「账号」页新建账号并生成密钥，再把公钥粘贴到对应平台的 SSH Keys 设置里。'
    }));
  }

  const identityFiles = {};
  accountList.forEach((account) => {
    const label = account.label + '（' + account.alias + '）';
    const base = { scope: 'account', targetId: account.id, targetLabel: label };

    // 密钥文件
    if (!fs.existsSync(account.keyPath || '')) {
      items.push(item(Object.assign({}, base, {
        level: 'error',
        title: '私钥文件不存在',
        detail: account.keyPath,
        fix: { action: 'generateKey', label: '生成密钥' }
      })));
    } else if (!fs.existsSync((account.keyPath || '') + '.pub')) {
      items.push(item(Object.assign({}, base, {
        level: 'error',
        title: '公钥文件缺失，无法粘贴到平台',
        detail: '可用 ssh-keygen -y -f 私钥 重新导出公钥',
        fix: { action: 'generateKey', label: '重新生成' }
      })));
    } else {
      items.push(item(Object.assign({}, base, {
        level: 'ok',
        title: '密钥对完整',
        detail: account.keyPath
      })));
    }

    // ssh config 块
    const inspect = sshConfig.inspectAccountBlock(account);
    if (!inspect.present) {
      items.push(item(Object.assign({}, base, {
        level: 'error',
        title: 'SSH 配置缺少该别名',
        detail: '缺少 Host ' + account.alias + ' 块，使用 git@' + account.alias + ' 地址时会直接失败或走默认密钥。',
        fix: { action: 'applySshConfig', label: '写入 SSH 配置' }
      })));
    } else if (!inspect.consistent) {
      items.push(item(Object.assign({}, base, {
        level: 'warn',
        title: 'SSH 配置块内容不完整',
        detail: 'HostName / IdentityFile / IdentitiesOnly 至少缺一项，可能导致密钥未按预期使用。',
        fix: { action: 'applySshConfig', label: '按账号重写该块' }
      })));
    } else {
      items.push(item(Object.assign({}, base, {
        level: 'ok',
        title: 'SSH 配置块正常',
        detail: inspect.block.split(/\r?\n/).filter((line) => line.trim()).join(' / ')
      })));
    }

    // 真实域名兜底映射
    // 别名块只在 URL 写别名时生效；裸域名（从网页复制的地址、老仓库的 remote）
    // 会退回 ~/.ssh/id_rsa，未把该默认公钥注册到平台就是 Permission denied，
    // 用户只能靠 ssh-add 临时救场 —— 这正是「公钥看起来没生效」的根因。
    const sameDomain = accounts.findAccountsByHostName(account.hostName);
    const domainInspect = sshConfig.inspectDomainBlock(account);
    if (sameDomain.length > 1) {
      items.push(item(Object.assign({}, base, {
        level: 'info',
        title: '同域名多账号，裸域名无法自动确定身份',
        detail: '域名 ' + account.hostName + ' 下已有 ' + sameDomain.length + ' 个账号（' +
          sameDomain.map((entry) => entry.alias).join('、') +
          '）。clone / remote 请统一使用别名地址 git@' + account.alias + ':owner/repo.git。'
      })));
    } else if (!domainInspect.present) {
      items.push(item(Object.assign({}, base, {
        level: 'warn',
        title: '裸域名地址不会使用该私钥',
        detail: 'git@' + account.hostName + ':owner/repo.git 这类地址不会命中别名块，ssh 只会尝试默认密钥 ~/.ssh/id_rsa，' +
          '出现 Permission denied (publickey)，只能靠 ssh-add 临时生效。为该域名生成兜底映射即可长期生效。',
        fix: { action: 'applyDomainMapping', label: '生成域名兜底映射' }
      })));
    } else if (!domainInspect.owned) {
      items.push(item(Object.assign({}, base, {
        level: 'info',
        title: '域名 ' + account.hostName + ' 已有手写 Host 块',
        detail: '该块不是本工具写入的，为避免覆盖你的配置不做改动。若裸域名认证失败，请手动检查其中的 IdentityFile。'
      })));
    } else if (!domainInspect.consistent) {
      items.push(item(Object.assign({}, base, {
        level: 'warn',
        title: '域名兜底块内容不完整',
        detail: 'Host ' + account.hostName + ' 块里的 HostName / IdentityFile 与账号不一致。',
        fix: { action: 'applyDomainMapping', label: '重写域名兜底映射' }
      })));
    } else {
      items.push(item(Object.assign({}, base, {
        level: 'ok',
        title: '域名兜底映射正常',
        detail: 'git@' + account.hostName + ':... 与 git@' + account.alias + ':... 都会使用 ' + account.keyPath
      })));
    }

    // 多个账号共用同一个私钥
    const key = String(account.keyPath || '').toLowerCase();
    if (key) {
      if (identityFiles[key]) {
        items.push(item(Object.assign({}, base, {
          level: 'error',
          title: '与其它账号共用同一私钥',
          detail: '该账号与「' + identityFiles[key] + '」指向同一个密钥文件，平台侧会把两者识别为同一个身份。',
          fix: { action: 'generateKey', label: '生成独立密钥' }
        })));
      } else {
        identityFiles[key] = account.label;
      }
    }
  });

  // 逐个账号连通性（可选）
  if (opts.testConnections) {
    for (const account of accountList) {
      const label = account.label + '（' + account.alias + '）';
      const result = await accounts.testConnection(account.id);
      items.push(item({
        scope: 'account',
        targetId: account.id,
        targetLabel: label,
        level: result.ok ? 'ok' : 'error',
        title: result.ok ? 'SSH 连通正常' : 'SSH 连通失败',
        detail: result.message,
        fix: null
      }));
    }
  }

  // ---------- 4. 项目 ----------
  const projectList = projects.listWithStatus();
  if (!projectList.length) {
    items.push(item({
      scope: 'project',
      level: 'info',
      title: '还没有登记项目',
      detail: '在「项目」页添加或扫描已有仓库，再绑定对应账号。'
    }));
  }

  for (const project of projectList) {
    const label = project.name;
    const base = { scope: 'project', targetId: project.id, targetLabel: label + '（' + project.path + '）' };

    if (!project.exists) {
      items.push(item(Object.assign({}, base, {
        level: 'error',
        title: '项目目录不存在',
        detail: project.path,
        fix: { action: 'removeProject', label: '从列表移除' }
      })));
      continue;
    }
    if (!project.isRepo) {
      items.push(item(Object.assign({}, base, {
        level: 'error',
        title: '目录不是 Git 仓库',
        detail: '未找到 .git 目录',
        fix: { action: 'removeProject', label: '从列表移除' }
      })));
      continue;
    }
    if (!gitRunner.resolveGit()) continue;

    const account = project.accountId ? accounts.find(project.accountId) : null;
    if (!account) {
      items.push(item(Object.assign({}, base, {
        level: 'warn',
        title: '未绑定账号',
        detail: '未绑定账号时无法保证 remote 与提交身份归属于同一身份。',
        fix: { action: 'openBind', label: '去绑定' }
      })));
      continue;
    }

    const remotes = await projects.getRemotes(project.id);
    if (!remotes.ok) {
      items.push(item(Object.assign({}, base, {
        level: 'warn',
        title: '读取远程地址失败',
        detail: remotes.error || ''
      })));
      continue;
    }
    const origin = remotes.items.find((r) => r.name === (project.remoteName || 'origin'));
    if (!origin) {
      items.push(item(Object.assign({}, base, {
        level: 'error',
        title: '缺少远程 ' + (project.remoteName || 'origin'),
        detail: '该仓库没有配置远程地址，无法推拉。',
        fix: { action: 'openBind', label: '去绑定并设置远程' }
      })));
    } else {
      const parsed = projects.parseRemoteUrl(origin.url);
      if (parsed.protocol !== 'ssh') {
        items.push(item(Object.assign({}, base, {
          level: 'warn',
          title: '远程地址使用 HTTPS',
          detail: origin.url + '。HTTPS 走系统凭据管理器，多账号容易串号；建议改写为 git@' + account.alias + ':' + (parsed.path || 'owner/repo.git') + '。',
          fix: { action: 'bind', label: '改写为别名 SSH 地址' }
        })));
      } else if (!projects.isUsingAlias(origin.url, account)) {
        items.push(item(Object.assign({}, base, {
          level: 'error',
          title: '远程地址未使用账号别名',
          detail: origin.url + ' 直接使用真实域名 ' + parsed.host + '，ssh 会优先尝试默认密钥，多账号下极易串号。建议改为 git@' + account.alias + ':' + parsed.path + '。',
          fix: { action: 'bind', label: '改写为别名地址' }
        })));
      } else {
        items.push(item(Object.assign({}, base, {
          level: 'ok',
          title: '远程地址已走账号别名',
          detail: origin.url
        })));
      }

      if (parsed.host && account.hostName && parsed.protocol === 'ssh' && projects.isUsingAlias(origin.url, account)) {
        // 别名正确时不用再校验域名，此处仅记录对应关系
        items.push(item(Object.assign({}, base, {
          level: 'info',
          title: '别名映射',
          detail: account.alias + ' → ' + account.hostName
        })));
      }
    }

    // 提交身份
    const identity = await projects.getLocalIdentity(project.id);
    const identityOk = identity.name === account.userName && identity.email === account.userEmail;
    if (!identity.name && !identity.email) {
      items.push(item(Object.assign({}, base, {
        level: 'warn',
        title: '仓库未设置本地提交身份',
        detail: '将继承全局身份，可能出现提交头像/邮箱与账号不一致。应设置为 ' + account.userName + ' <' + account.userEmail + '>。',
        fix: { action: 'bind', label: '写入本地身份' }
      })));
    } else if (!identityOk) {
      items.push(item(Object.assign({}, base, {
        level: 'warn',
        title: '提交身份与绑定账号不一致',
        detail: '当前 ' + (identity.name || '(未设)') + ' <' + (identity.email || '(未设)') + '>，绑定账号为 ' + account.userName + ' <' + account.userEmail + '>。',
        fix: { action: 'bind', label: '写入本地身份' }
      })));
    } else {
      items.push(item(Object.assign({}, base, {
        level: 'ok',
        title: '提交身份与账号一致',
        detail: identity.name + ' <' + identity.email + '>'
      })));
    }

    // 工作区状态（提示性）
    const runtime = await projects.getRuntime(project.id);
    if (runtime.ok) {
      items.push(item(Object.assign({}, base, {
        level: 'info',
        title: '工作区状态',
        detail: '分支 ' + runtime.branch + '，变更文件 ' + runtime.dirtyCount + ' 个' +
          (runtime.ahead ? '，领先上游 ' + runtime.ahead + ' 个提交' : '') +
          (runtime.behind ? '，落后上游 ' + runtime.behind + ' 个提交' : '')
      })));
    }
  }

  const summary = { error: 0, warn: 0, ok: 0, info: 0 };
  items.forEach((entry) => {
    summary[entry.level] = (summary[entry.level] || 0) + 1;
  });

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    summary: summary,
    items: items,
    versions: versions
  };
}

/**
 * 执行一条修复动作
 * @param {object} payload { action, accountId, projectId }
 * @returns {Promise<object>}
 */
async function applyFix(payload) {
  const action = String(payload.action || '');

  if (action === 'applySshConfig') {
    const account = accounts.find(payload.accountId);
    if (!account) return { ok: false, error: '账号不存在' };
    return accounts.applySshConfig(account.id);
  }

  if (action === 'applyAllSshConfig') {
    return { ok: true, results: accounts.applyAllSshConfig() };
  }

  if (action === 'applyDomainMapping') {
    return accounts.applyDomainMapping(payload.accountId);
  }

  if (action === 'switchSshClient') {
    const result = sshClient.switchTortoiseGitToOpenSsh();
    if (!result.ok) return result;
    const after = sshClient.detect();
    const remain = after.plinkSources.filter((source) => source.scope !== 'gui');
    return Object.assign({}, result, {
      ok: true,
      residual: remain.map((source) => source.key + ' = ' + source.value)
    });
  }

  if (action === 'removeDomainMapping') {
    return accounts.removeDomainMapping(payload.accountId);
  }

  if (action === 'generateKey') {
    return accounts.generateKey(payload.accountId, { force: Boolean(payload.force) });
  }

  if (action === 'bind') {
    return projects.bind(payload.projectId, payload.accountId);
  }

  if (action === 'removeProject') {
    return projects.remove(payload.projectId);
  }

  return { ok: false, error: '未知修复动作：' + action };
}

module.exports = { run, applyFix };
