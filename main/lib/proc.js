'use strict';

/**
 * 子进程执行封装
 * ------------------------------------------------------------
 * 统一负责：超时、输出编码、错误归一化、流式回调。
 * 所有外部命令（git / ssh / ssh-keygen）都从这里走，
 * 绝不拼接 shell 字符串，避免命令注入。
 * @author yittiger
 */

const { spawn } = require('child_process');

/**
 * 执行命令并等待结束
 * @param {string} command 可执行文件路径
 * @param {string[]} args 参数数组（注意：不经过 shell）
 * @param {object} [options]
 * @param {string} [options.cwd] 工作目录
 * @param {number} [options.timeout] 超时毫秒，默认 20s
 * @param {string} [options.input] 写入 stdin 的内容
 * @param {object} [options.env] 追加/覆盖的环境变量
 * @param {function} [options.onStdout] 增量输出回调
 * @param {function} [options.onStderr] 增量错误回调
 * @returns {Promise<{ok:boolean,code:number,stdout:string,stderr:string,timedOut:boolean,duration:number,error?:string}>}
 */
function runCommand(command, args, options) {
  const opts = options || {};
  const timeout = typeof opts.timeout === 'number' ? opts.timeout : 20000;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    try {
      child = spawn(command, args || [], {
        cwd: opts.cwd || undefined,
        windowsHide: true,
        env: Object.assign({}, process.env, opts.env || {})
      });
    } catch (err) {
      finish({
        ok: false,
        code: -1,
        stdout: '',
        stderr: '',
        timedOut: false,
        duration: 0,
        error: err && err.message ? err.message : String(err)
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch (err) {
        /* 忽略：进程可能已退出 */
      }
    }, timeout);

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stdout += text;
        if (typeof opts.onStdout === 'function') opts.onStdout(text);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stderr += text;
        if (typeof opts.onStderr === 'function') opts.onStderr(text);
      });
    }

    child.on('error', (err) => {
      clearTimeout(timer);
      // Windows 下 cwd 不存在时同样报 ENOENT，容易误判成「可执行文件不存在」，
      // 这里先区分一下，避免用户照着错误提示去改路径设置。
      let message;
      if (err && err.code === 'ENOENT' && opts.cwd && !require('fs').existsSync(opts.cwd)) {
        message = '工作目录不存在：' + opts.cwd;
      } else if (err && err.code === 'ENOENT') {
        message = '可执行文件不存在：' + command;
      } else {
        message = err && err.message ? err.message : String(err);
      }
      finish({
        ok: false,
        code: -1,
        stdout,
        stderr,
        timedOut,
        duration: Date.now() - startedAt,
        error: message
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      finish({
        ok: !timedOut && code === 0,
        code: typeof code === 'number' ? code : -1,
        stdout,
        stderr,
        timedOut,
        duration: Date.now() - startedAt
      });
    });

    if (opts.input !== null && typeof opts.input !== 'undefined') {
      try {
        child.stdin.write(opts.input);
      } catch (err) {
        /* 忽略：部分命令不接受 stdin */
      }
    }
    try {
      child.stdin.end();
    } catch (err) {
      /* 忽略 */
    }
  });
}

module.exports = { runCommand };
