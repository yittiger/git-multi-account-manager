'use strict';

/**
 * IPC 通信层
 * ------------------------------------------------------------
 * 渲染进程与主进程之间唯一的通道。
 * 所有通道统一返回 { ok, ... } 结构，异常在边界处被捕获，
 * 避免渲染进程拿到 undefined 而界面卡死。
 * @author yittiger
 */

const { ipcMain, dialog, shell, clipboard, BrowserWindow } = require('electron');
const fs = require('fs');

const store = require('./store');
const paths = require('./paths');
const accounts = require('./accounts');
const projects = require('./projects');
const diagnose = require('./diagnose');
const gitRunner = require('./gitRunner');

/**
 * 统一包装 handler：捕获异常并记录日志，保证返回值可序列化
 * @param {string} channel 通道名
 * @param {function} handler 处理函数
 */
function handle(channel, handler) {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      const result = await handler(payload, event);
      return typeof result === 'undefined' ? { ok: true } : result;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ipc] ' + channel + ' 失败：', err);
      return { ok: false, error: (err && err.message) ? err.message : String(err) };
    }
  });
}

/**
 * 注册全部 IPC 通道
 */
function register() {
  // ---------- 应用信息 ----------
  handle('app:info', async () => {
    const versions = await gitRunner.probeVersions();
    return {
      ok: true,
      versions: versions,
      providers: accounts.PROVIDERS,
      keyTypes: accounts.KEY_TYPES,
      paths: {
        home: paths.HOME,
        sshDir: paths.SSH_DIR,
        sshConfig: paths.SSH_CONFIG_FILE,
        appDir: paths.APP_DIR,
        configFile: store.getConfigFilePath()
      },
      settings: store.loadState().settings,
      platform: process.platform,
      appVersion: require('../../package.json').version
    };
  });

  // ---------- 设置 ----------
  handle('settings:save', (payload) => {
    const saved = store.updateSettings(payload || {});
    gitRunner.clearCache();
    return { ok: true, settings: saved };
  });

  handle('settings:reset', () => {
    const saved = store.updateSettings({ gitPath: '', sshPath: '', sshKeygenPath: '' });
    gitRunner.clearCache();
    return { ok: true, settings: saved };
  });

  // ---------- 账号 ----------
  handle('accounts:list', () => ({ ok: true, items: accounts.listWithStatus() }));

  handle('accounts:save', (payload) => accounts.save(payload));

  handle('accounts:delete', (payload) => accounts.remove(payload.id, {
    removeSshBlock: payload.removeSshBlock !== false,
    keepKeyFiles: payload.keepKeyFiles !== false
  }));

  handle('accounts:generateKey', (payload) => accounts.generateKey(payload.id, { force: Boolean(payload.force) }));

  handle('accounts:publicKey', (payload) => accounts.readPublicKey(payload.id));

  handle('accounts:previewBlock', (payload) => accounts.previewBlock(payload.id));

  handle('accounts:applySshConfig', (payload) => accounts.applySshConfig(payload.id));

  handle('accounts:applyAll', () => ({ ok: true, results: accounts.applyAllSshConfig() }));

  handle('accounts:applyDomainMapping', (payload) => accounts.applyDomainMapping(payload.id));

  handle('accounts:removeDomainMapping', (payload) => accounts.removeDomainMapping(payload.id));

  handle('accounts:test', (payload) => accounts.testConnection(payload.id));

  handle('accounts:localKeys', () => ({ ok: true, items: accounts.listLocalKeys() }));

  handle('accounts:importKey', (payload) => {
    // 把已有密钥登记到账号上：只更新路径，不触碰密钥文件
    const account = accounts.find(payload.id);
    if (!account) return { ok: false, error: '账号不存在' };
    const keyPath = String(payload.keyPath || '').trim();
    if (!keyPath || !fs.existsSync(keyPath)) return { ok: false, error: '密钥文件不存在：' + keyPath };
    const saved = accounts.save(Object.assign({}, account, { keyPath: keyPath }));
    return saved;
  });

  // ---------- 项目 ----------
  handle('projects:list', () => ({ ok: true, items: projects.listWithStatus() }));

  handle('projects:add', (payload) => projects.add(payload));

  handle('projects:update', (payload) => projects.update(payload.id, payload.patch));

  handle('projects:remove', (payload) => projects.remove(payload.id));

  handle('projects:scan', (payload) => projects.scanRepos(payload || {}));

  handle('projects:addBatch', (payload) => {
    const list = Array.isArray(payload.items) ? payload.items : [];
    const results = list.map((item) => projects.add({ path: item.path, accountId: item.accountId || '' }));
    return { ok: true, results: results };
  });

  handle('projects:previewBind', (payload) => projects.previewBind(payload.id, payload.accountId));

  handle('projects:bind', (payload) => projects.bind(payload.id, payload.accountId, payload.options || {}));

  handle('projects:runtime', (payload) => projects.getRuntime(payload.id));

  handle('projects:branches', (payload) => projects.getBranches(payload.id));

  handle('projects:log', (payload) => projects.getLog(payload.id, payload.count));

  handle('projects:remotes', (payload) => projects.getRemotes(payload.id));

  handle('projects:clone', (payload) => projects.clone(payload));

  // ---------- Git 动作（流式） ----------
  ipcMain.on('git:action', async (event, payload) => {
    const reqId = payload && payload.reqId;
    const plan = projects.buildActionArgs(payload && payload.projectId, payload && payload.action, payload && payload.extra);

    const send = (type, data) => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
          win.webContents.send('git:action:' + type, Object.assign({ reqId: reqId }, data));
        }
      } catch (err) {
        /* 窗口可能已关闭 */
      }
    };

    if (!plan.ok) {
      send('done', { result: { ok: false, error: plan.error, command: '' } });
      return;
    }

    send('start', { command: 'git ' + plan.args.join(' '), cwd: plan.cwd });

    const result = await gitRunner.runGit(plan.args, {
      cwd: plan.cwd,
      timeout: payload.timeout || 180000,
      onStdout: (text) => send('chunk', { stream: 'stdout', text: text }),
      onStderr: (text) => send('chunk', { stream: 'stderr', text: text })
    });

    send('done', { result: result });
  });

  // ---------- 诊断 ----------
  handle('diagnose:run', (payload) => diagnose.run(payload || {}));

  handle('diagnose:fix', (payload) => diagnose.applyFix(payload || {}));

  // ---------- 系统交互 ----------
  handle('dialog:selectFolder', async (payload) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win, {
      title: (payload && payload.title) || '选择目录',
      defaultPath: (payload && payload.defaultPath) || paths.HOME,
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  });

  handle('clipboard:copy', (payload) => {
    clipboard.writeText(String((payload && payload.text) || ''));
    return { ok: true };
  });

  handle('shell:openPath', async (payload) => {
    const target = String((payload && payload.path) || '');
    if (!target) return { ok: false, error: '路径为空' };
    if (!fs.existsSync(target)) return { ok: false, error: '路径不存在：' + target };
    const error = await shell.openPath(target);
    return error ? { ok: false, error: error } : { ok: true };
  });

  handle('shell:openExternal', async (payload) => {
    const url = String((payload && payload.url) || '');
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '仅支持 http/https 链接' };
    await shell.openExternal(url);
    return { ok: true };
  });

  handle('shell:revealItem', (payload) => {
    const target = String((payload && payload.path) || '');
    if (!target || !fs.existsSync(target)) return { ok: false, error: '路径不存在' };
    shell.showItemInFolder(target);
    return { ok: true };
  });
}

module.exports = { register };
