'use strict';

/**
 * 冒烟测试（以 Electron 主进程身份运行）
 * ------------------------------------------------------------
 * 用途：不弹窗口地加载真实页面，捕获渲染进程报错，并对关键 DOM 与
 * IPC 通道做一次连通性检查。CI 或改完代码后跑一遍即可。
 *
 * 运行：node_modules\\.bin\\electron test\\smoke.js
 * @author yittiger
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const registerIpc = require('../main/lib/ipc');

const messages = [];

/**
 * 等待指定毫秒
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.whenReady().then(async () => {
  registerIpc.register();

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.webContents.on('console-message', (event, level, message) => {
    messages.push('[console:' + level + '] ' + message);
  });

  win.webContents.on('did-fail-load', (event, code, description, url) => {
    messages.push('[did-fail-load] ' + code + ' ' + description + ' ' + url);
  });

  win.webContents.on('render-process-gone', (event, details) => {
    messages.push('[render-gone] ' + JSON.stringify(details));
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await sleep(1500);

  const domReport = await win.webContents.executeJavaScript(
    'JSON.stringify({' +
      'hasVue: typeof window.Vue !== "undefined",' +
      'hasApi: typeof window.gitApi !== "undefined",' +
      'navCount: document.querySelectorAll(".nav-item").length,' +
      'activeNav: (document.querySelector(".nav-item.active") || {}).textContent,' +
      'accountCards: document.querySelectorAll(".account-card").length,' +
      'renderedTabs: document.querySelectorAll(".toolbar-title").length,' +
      'gitPill: (document.querySelector(".pill") || {}).textContent' +
    '})'
  );

  const ipcReport = await win.webContents.executeJavaScript(
    '(async function () {' +
      '  const out = {};' +
      '  out.info = await window.gitApi.appInfo();' +
      '  out.accounts = await window.gitApi.accounts.list();' +
      '  out.projects = await window.gitApi.projects.list();' +
      '  out.diagnose = await window.gitApi.diagnose.run({ testConnections: false });' +
      '  return JSON.stringify({' +
      '    infoOk: !!(out.info && out.info.ok),' +
      '    gitPath: out.info && out.info.versions ? out.info.versions.git.path : null,' +
      '    accountsOk: !!(out.accounts && out.accounts.ok),' +
      '    projectsOk: !!(out.projects && out.projects.ok),' +
      '    diagnoseOk: !!(out.diagnose && out.diagnose.ok),' +
      '    diagErrors: out.diagnose && out.diagnose.summary ? out.diagnose.summary.error : null' +
      '  });' +
      '})()'
  );

  const uiReport = await win.webContents.executeJavaScript(
    '(async function () {' +
      '  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }' +
      '  var vm = document.querySelector("#app").__vue__;' +
      '  vm.accounts = [{' +
      '    id: "a1", label: "公司 Gitee", provider: "gitee", hostName: "gitee.com", port: 22,' +
      '    alias: "gitee-work", userName: "张三", userEmail: "work@example.com", keyType: "ed25519",' +
      '    keyPath: "C:\\\\Users\\\\x\\\\.ssh\\\\gitee-work", keyExists: true, pubExists: true,' +
      '    publicKeyType: "ssh-ed25519", sshConfigPresent: true, sshConfigConsistent: true' +
      '  }];' +
      '  vm.projects = [{ id: "p1", name: "demo-repo", path: "D:\\\\code\\\\demo", exists: true, isRepo: true,' +
      '    accountLabel: "公司 Gitee", accountAlias: "gitee-work" }];' +
      '  await wait(400);' +
      '  var report = {};' +
      '  report.accountCards = document.querySelectorAll(".account-card").length;' +
      '  report.accountBadges = document.querySelectorAll(".account-status .badge").length;' +
      '  var createBtn = Array.prototype.slice.call(document.querySelectorAll("button"))' +
      '    .filter(function (b) { return b.textContent.indexOf("新建账号") >= 0; })[0];' +
      '  if (createBtn) createBtn.click();' +
      '  await wait(350);' +
      '  report.createModalShown = Boolean(document.querySelector(".modal-box"));' +
      '  report.createModalFields = document.querySelectorAll(".modal-box .input").length;' +
      '  var closeBtn = document.querySelector(".modal-head .close");' +
      '  if (closeBtn) closeBtn.click();' +
      '  await wait(250);' +
      '  vm.switchTab("projects");' +
      '  await wait(350);' +
      '  report.projectRows = document.querySelectorAll(".table tbody tr").length;' +
      '  vm.switchTab("accounts");' +
      '  return JSON.stringify(report);' +
      '})()'
  );

  const report = {
    generatedAt: new Date().toISOString(),
    dom: JSON.parse(domReport),
    ipc: JSON.parse(ipcReport),
    ui: JSON.parse(uiReport),
    rendererMessages: messages
  };

  // Windows 下 GUI 子进程的 stdout 不一定能回传到终端，因此同时落盘一份报告
  fs.writeFileSync(path.join(__dirname, 'smoke-report.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log('--- DOM ---');
  console.log(domReport);
  console.log('--- IPC ---');
  console.log(ipcReport);
  console.log('--- UI ---');
  console.log(uiReport);
  console.log('--- 渲染进程日志 ---');
  console.log(messages.length ? messages.join('\n') : '(无)');

  app.quit();
});
