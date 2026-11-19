'use strict';

/**
 * 预加载脚本
 * ------------------------------------------------------------
 * 通过 contextBridge 暴露受限的 API，渲染进程不接触 Node。
 * 所有通道名集中在这里，前端只需调用语义化方法。
 * @author yittiger
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 调用主进程并解包结果
 * @param {string} channel 通道
 * @param {object} [payload] 参数
 * @returns {Promise<object>}
 */
function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload || {});
}

contextBridge.exposeInMainWorld('gitApi', {
  appInfo: () => invoke('app:info'),

  settings: {
    save: (patch) => invoke('settings:save', patch),
    reset: () => invoke('settings:reset')
  },

  accounts: {
    list: () => invoke('accounts:list'),
    save: (payload) => invoke('accounts:save', payload),
    remove: (payload) => invoke('accounts:delete', payload),
    generateKey: (payload) => invoke('accounts:generateKey', payload),
    publicKey: (id) => invoke('accounts:publicKey', { id }),
    previewBlock: (id) => invoke('accounts:previewBlock', { id }),
    applySshConfig: (id) => invoke('accounts:applySshConfig', { id }),
    applyAll: () => invoke('accounts:applyAll'),
    applyDomainMapping: (id) => invoke('accounts:applyDomainMapping', { id }),
    removeDomainMapping: (id) => invoke('accounts:removeDomainMapping', { id }),
    test: (id) => invoke('accounts:test', { id }),
    localKeys: () => invoke('accounts:localKeys'),
    importKey: (payload) => invoke('accounts:importKey', payload)
  },

  projects: {
    list: () => invoke('projects:list'),
    add: (payload) => invoke('projects:add', payload),
    update: (payload) => invoke('projects:update', payload),
    remove: (id) => invoke('projects:remove', { id }),
    scan: (payload) => invoke('projects:scan', payload),
    addBatch: (payload) => invoke('projects:addBatch', payload),
    previewBind: (payload) => invoke('projects:previewBind', payload),
    bind: (payload) => invoke('projects:bind', payload),
    runtime: (id) => invoke('projects:runtime', { id }),
    branches: (id) => invoke('projects:branches', { id }),
    log: (payload) => invoke('projects:log', payload),
    remotes: (id) => invoke('projects:remotes', { id }),
    clone: (payload) => invoke('projects:clone', payload)
  },

  git: {
    /**
     * 执行动作并接收流式输出
     * @param {object} payload { reqId, projectId, action, extra }
     * @param {function} onStart 开始回调
     * @param {function} onChunk 输出回调 (stream, text)
     * @param {function} onDone 结束回调 (result)
     */
    run: (payload, onStart, onChunk, onDone) => {
      const reqId = payload.reqId;
      const startListener = (event, data) => {
        if (data.reqId !== reqId) return;
        if (typeof onStart === 'function') onStart(data);
      };
      const chunkListener = (event, data) => {
        if (data.reqId !== reqId) return;
        if (typeof onChunk === 'function') onChunk(data.stream, data.text);
      };
      const doneListener = (event, data) => {
        if (data.reqId !== reqId) return;
        ipcRenderer.removeListener('git:action:start', startListener);
        ipcRenderer.removeListener('git:action:chunk', chunkListener);
        ipcRenderer.removeListener('git:action:done', doneListener);
        if (typeof onDone === 'function') onDone(data.result);
      };
      ipcRenderer.on('git:action:start', startListener);
      ipcRenderer.on('git:action:chunk', chunkListener);
      ipcRenderer.on('git:action:done', doneListener);
      ipcRenderer.send('git:action', payload);
    }
  },

  diagnose: {
    run: (payload) => invoke('diagnose:run', payload),
    fix: (payload) => invoke('diagnose:fix', payload)
  },

  system: {
    selectFolder: (payload) => invoke('dialog:selectFolder', payload),
    copy: (text) => invoke('clipboard:copy', { text }),
    openPath: (target) => invoke('shell:openPath', { path: target }),
    openExternal: (url) => invoke('shell:openExternal', { url }),
    reveal: (target) => invoke('shell:revealItem', { path: target }),
    sshClient: () => invoke('system:sshClient'),
    switchSshClient: () => invoke('system:switchSshClient')
  }
});
