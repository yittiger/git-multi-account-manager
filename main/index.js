'use strict';

/**
 * Electron 主进程入口
 * ------------------------------------------------------------
 * 只负责：窗口创建、生命周期、IPC 注册。
 * 业务逻辑全部在 lib/ 下，便于单独测试与复用。
 * @author yittiger
 */

const path = require('path');
const { app, BrowserWindow, Menu, shell } = require('electron');
const registerIpc = require('./lib/ipc');

const isDev = process.argv.includes('--dev');

// 单实例：多开会同时写同一份配置，容易互相覆盖
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  let mainWindow = null;

  /**
   * 创建主窗口
   */
  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 1040,
      minHeight: 660,
      show: false,
      backgroundColor: '#0d1117',
      title: 'Git 多账号管理器',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false
      }
    });

    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
    });

    // 外部链接一律用系统浏览器打开，不在应用内跳转
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    if (isDev) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpc.register();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
