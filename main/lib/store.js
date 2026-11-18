'use strict';

/**
 * 本地配置持久化
 * ------------------------------------------------------------
 * 文件位置：~/.git-tools/config.json
 * 采用「原子写入」（先写临时文件再重命名），避免写一半断电导致配置损坏；
 * 文件损坏时自动备份原文件并回退到默认配置，不让应用直接崩溃。
 * @author yittiger
 */

const fs = require('fs');
const path = require('path');
const { APP_CONFIG_FILE, APP_DIR, ensureDir, readFileSafe } = require('./paths');

const STORE_VERSION = 1;

/**
 * 默认配置结构
 * @returns {object}
 */
function createDefaultState() {
  return {
    version: STORE_VERSION,
    settings: {
      // 可执行文件路径；留空表示自动探测
      gitPath: '',
      sshPath: '',
      sshKeygenPath: '',
      // 新建密钥默认算法
      defaultKeyType: 'ed25519',
      // 扫描项目目录时的递归深度
      scanDepth: 3
    },
    accounts: [],
    projects: []
  };
}

/**
 * 生成短 ID
 * @param {string} prefix 前缀
 * @returns {string}
 */
function createId(prefix) {
  const random = Math.random().toString(36).slice(2, 8);
  return prefix + '_' + Date.now().toString(36) + random;
}

let cache = null;

/**
 * 读取配置（带内存缓存）
 * @param {boolean} [forceReload] 是否强制重读磁盘
 * @returns {object}
 */
function loadState(forceReload) {
  if (cache && !forceReload) return cache;

  const defaults = createDefaultState();
  const raw = readFileSafe(APP_CONFIG_FILE);

  if (!raw) {
    cache = defaults;
    return cache;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // 配置损坏：备份后回退默认，避免用户数据被静默清空
    const backup = APP_CONFIG_FILE + '.corrupt-' + Date.now() + '.bak';
    try {
      fs.copyFileSync(APP_CONFIG_FILE, backup);
    } catch (copyErr) {
      /* 备份失败不影响主流程 */
    }
    cache = defaults;
    return cache;
  }

  cache = {
    version: STORE_VERSION,
    settings: Object.assign({}, defaults.settings, parsed.settings || {}),
    accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
    projects: Array.isArray(parsed.projects) ? parsed.projects : []
  };
  return cache;
}

/**
 * 写入配置到磁盘
 * @param {object} state 完整状态
 * @returns {object} 写入后的状态
 */
function saveState(state) {
  ensureDir(APP_DIR);
  const content = JSON.stringify(state, null, 2);
  const tmpFile = APP_CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmpFile, content, 'utf8');
  fs.renameSync(tmpFile, APP_CONFIG_FILE);
  cache = state;
  return state;
}

/**
 * 读取指定 key 的配置项
 * @param {string} key settings 下的键名
 * @param {*} fallback 默认值
 * @returns {*}
 */
function getSetting(key, fallback) {
  const state = loadState();
  const value = state.settings ? state.settings[key] : undefined;
  return typeof value === 'undefined' || value === null || value === '' ? fallback : value;
}

/**
 * 更新 settings
 * @param {object} patch 增量
 * @returns {object} 新的 settings
 */
function updateSettings(patch) {
  const state = loadState();
  state.settings = Object.assign({}, state.settings, patch || {});
  saveState(state);
  return state.settings;
}

/**
 * 读取配置文件的绝对路径（界面展示用）
 * @returns {string}
 */
function getConfigFilePath() {
  return path.join(APP_DIR, 'config.json');
}

module.exports = {
  STORE_VERSION,
  createDefaultState,
  createId,
  loadState,
  saveState,
  getSetting,
  updateSettings,
  getConfigFilePath,
  CONFIG_FILE: APP_CONFIG_FILE
};
