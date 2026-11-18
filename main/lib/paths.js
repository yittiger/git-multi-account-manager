'use strict';

/**
 * 路径与目录约定
 * ------------------------------------------------------------
 * 所有模块共用这里的路径常量，避免各处理 scatter 拼接。
 *   ~/.ssh        : 密钥、config、known_hosts
 *   ~/.git-tools  : 本工具的持久化配置与日志（用户可直接查看/备份）
 * @author yittiger
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const HOME = os.homedir();
const SSH_DIR = path.join(HOME, '.ssh');
const SSH_CONFIG_FILE = path.join(SSH_DIR, 'config');
const APP_DIR = path.join(HOME, '.git-tools');
const APP_CONFIG_FILE = path.join(APP_DIR, 'config.json');
const APP_LOG_DIR = path.join(APP_DIR, 'logs');

/**
 * 确保目录存在
 * @param {string} dir 目录绝对路径
 * @returns {string} 原路径
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 把 ~ 开头的路径展开为绝对路径
 * @param {string} input 用户输入路径
 * @returns {string} 绝对路径
 */
function expandPath(input) {
  if (!input) return '';
  const value = String(input).trim();
  if (value === '~') return HOME;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(HOME, value.slice(2));
  }
  return value;
}

/**
 * 把 HOME 下的绝对路径转成 ~ 相对写法（写进 ssh config 更便携）
 * @param {string} absPath 绝对路径
 * @returns {string} 例如 ~/.ssh/gitee_work
 */
function toHomeRelative(absPath) {
  if (!absPath) return '';
  const normalized = path.normalize(absPath);
  const homeNormalized = path.normalize(HOME);
  if (normalized.toLowerCase().startsWith(homeNormalized.toLowerCase())) {
    const rest = normalized.slice(homeNormalized.length).replace(/\\/g, '/').replace(/^\//, '');
    return rest ? '~/' + rest : '~';
  }
  return absPath.replace(/\\/g, '/');
}

/**
 * 生成账号密钥的默认存放路径
 * @param {string} alias SSH Host 别名，同时作为密钥文件名
 * @returns {string} 绝对路径（私钥）
 */
function defaultKeyPath(alias) {
  const safe = String(alias).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(SSH_DIR, safe);
}

/**
 * 读取文件，不存在返回 null
 * @param {string} file 文件路径
 * @returns {string|null}
 */
function readFileSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null;
  }
}

/**
 * 写入文件（自动建父目录）
 * @param {string} file 文件路径
 * @param {string} content 内容
 * @param {string} [encoding] 编码
 */
function writeFileSafe(file, content, encoding) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, { encoding: encoding || 'utf8' });
}

module.exports = {
  HOME,
  SSH_DIR,
  SSH_CONFIG_FILE,
  APP_DIR,
  APP_CONFIG_FILE,
  APP_LOG_DIR,
  ensureDir,
  expandPath,
  toHomeRelative,
  defaultKeyPath,
  readFileSafe,
  writeFileSafe
};
