'use strict';

/**
 * 核心逻辑测试（纯 Node 运行，不依赖 Electron 窗口）
 * ------------------------------------------------------------
 * 关键点：把 USERPROFILE 指向临时目录，所有 ~/.ssh 与 ~/.git-tools 操作
 * 都发生在沙箱里，不会碰用户真实配置。
 *
 * 运行：node test/lib-test.js
 * @author yittiger
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在 require 业务模块之前改，paths.js 在模块加载时就读取了 home
const tmpHome = path.join(os.tmpdir(), 'git-tools-test-' + Date.now());
fs.mkdirSync(path.join(tmpHome, '.ssh'), { recursive: true });
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;

const sshConfig = require('../main/lib/sshConfig');
const accounts = require('../main/lib/accounts');
const projects = require('../main/lib/projects');
const store = require('../main/lib/store');

const results = [];

/**
 * 记录一条断言
 * @param {string} name 用例名
 * @param {boolean} pass 是否通过
 * @param {string} [extra] 附加信息
 */
function check(name, pass, extra) {
  results.push({ name: name, pass: Boolean(pass), extra: extra || '' });
}

/**
 * 主流程
 */
async function main() {
  // ---------- 1. 远程地址解析 ----------
  const scp = projects.parseRemoteUrl('git@gitee.com:owner/repo.git');
  check('解析 scp 形式地址', scp.protocol === 'ssh' && scp.host === 'gitee.com' && scp.path === 'owner/repo.git', JSON.stringify(scp));

  const sshUrl = projects.parseRemoteUrl('ssh://git@gitlab.example.com:2222/group/sub/repo.git');
  check('解析 ssh:// 带端口地址', sshUrl.protocol === 'ssh' && sshUrl.port === 2222 && sshUrl.path === 'group/sub/repo.git', JSON.stringify(sshUrl));

  const httpsUrl = projects.parseRemoteUrl('https://gitee.com/owner/repo.git');
  check('解析 https 地址', httpsUrl.protocol === 'https' && httpsUrl.path === 'owner/repo.git', JSON.stringify(httpsUrl));

  const aliasUrl = projects.buildAliasUrl({ alias: 'gitee-work' }, httpsUrl.path);
  check('生成别名地址', aliasUrl === 'git@gitee-work:owner/repo.git', aliasUrl);

  check('识别已使用别名', projects.isUsingAlias('git@gitee-work:owner/repo.git', { alias: 'gitee-work' }) === true);

  // ---------- 2. 预置已有 ssh config，验证不被破坏 ----------
  const configFile = path.join(tmpHome, '.ssh', 'config');
  const originalConfig = [
    '# 我手工维护的配置，不能被工具覆盖',
    'Host github.com',
    '  HostName github.com',
    '  User git',
    '  IdentityFile ~/.ssh/id_rsa',
    '',
    'Host gitee.com',
    '  HostName gitee.com',
    '  User git',
    ''
  ].join('\n');
  fs.writeFileSync(configFile, originalConfig, 'utf8');

  // ---------- 3. 账号校验与保存 ----------
  const badAlias = accounts.save({
    label: '错误别名',
    provider: 'gitee',
    hostName: 'gitee.com',
    alias: 'gitee.com',
    userName: '测试',
    userEmail: 'test@example.com'
  });
  check('拒绝别名等于域名', badAlias.ok === false && Boolean(badAlias.errors.alias), JSON.stringify(badAlias.errors || {}));

  const saved = accounts.save({
    label: '公司 Gitee',
    provider: 'gitee',
    hostName: 'gitee.com',
    alias: 'gitee-work',
    userName: '张三',
    userEmail: 'work@example.com',
    keyType: 'ed25519'
  });
  check('保存账号成功', saved.ok === true, JSON.stringify(saved.errors || {}));

  const accountId = saved.ok ? saved.account.id : '';
  check('默认密钥路径落在 ~/.ssh', saved.ok && saved.account.keyPath === path.join(tmpHome, '.ssh', 'gitee-work'), saved.ok ? saved.account.keyPath : '');
  check('IdentityFile 写作 ~/ 形式', saved.ok && saved.account.identityFileHint === '~/.ssh/gitee-work', saved.ok ? saved.account.identityFileHint : '');

  // ---------- 4. 写入 ssh config（关键：保留原有内容） ----------
  const applied = accounts.applySshConfig(accountId);
  check('写入配置成功', applied.ok === true && applied.changed === true, applied.error || '');

  const configText = fs.readFileSync(configFile, 'utf8');
  check('保留原有 Host github.com 块', configText.indexOf('Host github.com') >= 0 && configText.indexOf('HostName github.com') >= 0);
  check('保留手工注释', configText.indexOf('我手工维护的配置') >= 0);
  check('新增托管块', configText.indexOf('Host gitee-work') >= 0 && configText.indexOf('IdentitiesOnly yes') >= 0);
  check('生成备份文件', fs.existsSync(configFile + '.git-tools.bak'));
  check('备份内容等于改前原文', fs.readFileSync(configFile + '.git-tools.bak', 'utf8') === originalConfig);

  const inspect1 = sshConfig.inspectAccountBlock(accounts.find(accountId));
  check('配置块被识别且完整', inspect1.present === true && inspect1.consistent === true, JSON.stringify(inspect1));

  // 重复写入应当是幂等的
  const appliedAgain = accounts.applySshConfig(accountId);
  check('重复写入幂等（不产生变更）', appliedAgain.changed === false, String(appliedAgain.changed));

  // ---------- 5. 密钥生成 ----------
  const keyResult = await accounts.generateKey(accountId, { force: false });
  const account = accounts.find(accountId);
  check('生成密钥成功', keyResult.ok === true, keyResult.error || '');
  check('私钥文件存在', fs.existsSync(account.keyPath));
  check('公钥文件存在', fs.existsSync(account.keyPath + '.pub'));

  const pub = accounts.readPublicKey(accountId);
  check('读取公钥内容', pub.ok === true && pub.value.indexOf('ssh-ed25519') === 0, (pub.value || pub.error || '').slice(0, 60));

  // ---------- 5.1 域名兜底映射 ----------
  // 裸域名（git@github.com:...）不会命中别名块，必须靠域名兜底块
  const glAccount = accounts.save({
    label: 'GitLab 个人',
    provider: 'gitlab',
    hostName: 'gitlab.com',
    alias: 'gl-person',
    userName: '王五',
    userEmail: 'gl@example.com'
  });
  check('保存 GitLab 账号', glAccount.ok === true, JSON.stringify(glAccount.errors || {}));

  const glId = glAccount.ok ? glAccount.account.id : '';
  const domainApplied = accounts.applyDomainMapping(glId);
  check('生成域名兜底映射成功', domainApplied.ok === true && domainApplied.detail.changed === true, domainApplied.error || '');

  const configWithDomain = fs.readFileSync(configFile, 'utf8');
  check('域名兜底块以真实域名作 Host', /Host gitlab\.com/m.test(configWithDomain));
  check('域名兜底块带 domain 标记', configWithDomain.indexOf('# git-tools:domain=' + glId) >= 0);
  check('域名兜底块指向同一私钥', /IdentityFile ~\/\.ssh\/gl-person/.test(configWithDomain));

  const domainInspect = sshConfig.inspectDomainBlock(accounts.find(glId));
  check('域名兜底块被识别为工具托管', domainInspect.present === true && domainInspect.owned === true && domainInspect.consistent === true, JSON.stringify(domainInspect));

  const domainAgain = accounts.applyDomainMapping(glId);
  check('域名兜底重复写入幂等', domainAgain.ok === true && domainAgain.detail.changed === false, JSON.stringify(domainAgain.detail || {}));

  // 手写的 Host 块绝不能被覆盖
  const handWritten = accounts.applyDomainMapping(accountId);
  check('拒绝覆盖手写的 Host 块', handWritten.ok === false && /手写/.test(handWritten.error || ''), handWritten.error || '');
  check('手写块内容保持原样', fs.readFileSync(configFile, 'utf8').indexOf('IdentityFile ~/.ssh/id_rsa') >= 0);

  const domainRemoved = accounts.removeDomainMapping(glId);
  check('移除域名兜底块', domainRemoved.ok === true && domainRemoved.detail.changed === true);
  check('移除后不再有 gitlab.com 托管块', fs.readFileSync(configFile, 'utf8').indexOf('Host gitlab.com') < 0);

  // 克隆入参校验：目标目录不存在时给出准确提示，而不是「可执行文件不存在」
  const cloneMissingDir = await projects.clone({
    url: 'git@gitlab.com:owner/repo.git',
    targetDir: path.join(tmpHome, 'not-exists-dir'),
    folderName: 'x'
  });
  check('克隆前校验目标目录', cloneMissingDir.ok === false && /目标目录不存在/.test(cloneMissingDir.error || ''), cloneMissingDir.error || '');

  // ---------- 6. 重复别名校验 ----------
  const dup = accounts.save({
    label: '另一个账号',
    provider: 'gitee',
    hostName: 'gitee.com',
    alias: 'gitee-work',
    userName: '李四',
    userEmail: 'person@example.com'
  });
  check('拒绝重复别名', dup.ok === false && Boolean(dup.errors.alias), JSON.stringify(dup.errors || {}));

  // ---------- 7. 第二个账号 + 删除 ----------
  const second = accounts.save({
    label: '个人 Gitee',
    provider: 'gitee',
    hostName: 'gitee.com',
    alias: 'gitee-person',
    userName: '李四',
    userEmail: 'person@example.com'
  });
  check('保存第二个同域名账号', second.ok === true, JSON.stringify(second.errors || {}));
  const secondId = second.ok ? second.account.id : '';
  accounts.applySshConfig(secondId);

  const configAfterSecond = fs.readFileSync(configFile, 'utf8');
  check('两个同域名账号块共存',
    configAfterSecond.indexOf('Host gitee-work') >= 0 && configAfterSecond.indexOf('Host gitee-person') >= 0);

  // 同域名多账号时裸域名无法确定身份，必须拒绝兜底映射
  const multiDomain = accounts.applyDomainMapping(secondId);
  check('同域名多账号时拒绝域名兜底', multiDomain.ok === false && /2 个账号/.test(multiDomain.error || ''), multiDomain.error || '');

  const removed = accounts.remove(secondId, { removeSshBlock: true, keepKeyFiles: true });
  check('删除账号成功', removed.ok === true, JSON.stringify(removed));
  const configAfterRemove = fs.readFileSync(configFile, 'utf8');
  check('删除后仅移除对应块', configAfterRemove.indexOf('gitee-person') < 0 && configAfterRemove.indexOf('Host gitee-work') >= 0);
  check('删除后其它 Host 仍在', configAfterRemove.indexOf('Host github.com') >= 0);

  // ---------- 8. 存储健壮性 ----------
  const stateBefore = store.loadState();
  check('配置文件已生成', fs.existsSync(store.getConfigFilePath()), store.getConfigFilePath());
  const parsedState = JSON.parse(fs.readFileSync(store.getConfigFilePath(), 'utf8'));
  check('状态结构完整', Array.isArray(parsedState.accounts) && Array.isArray(parsedState.projects) && Boolean(parsedState.settings));

  // 损坏的配置应当被容错，更不能抛出
  fs.writeFileSync(store.getConfigFilePath(), '{ 这不是合法 json', 'utf8');
  let corrupted;
  try {
    corrupted = store.loadState(true);
  } catch (err) {
    corrupted = null;
  }
  check('配置损坏时回退默认而不崩溃', Boolean(corrupted) && Array.isArray(corrupted.accounts));

  // ---------- 汇总 ----------
  const passed = results.filter((item) => item.pass).length;
  const failed = results.filter((item) => !item.pass);

  console.log('');
  results.forEach((item) => {
    console.log((item.pass ? 'PASS  ' : 'FAIL  ') + item.name + (item.pass ? '' : '   → ' + item.extra));
  });
  console.log('');
  console.log('共 ' + results.length + ' 项，通过 ' + passed + ' 项，失败 ' + failed.length + ' 项');
  console.log('测试沙箱目录：' + tmpHome);

  fs.writeFileSync(
    path.join(__dirname, 'lib-test-report.json'),
    JSON.stringify({ passed: passed, failed: failed.length, total: results.length, tmpHome: tmpHome, results: results }, null, 2),
    'utf8'
  );

  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('测试执行异常：', err);
  process.exitCode = 1;
});
