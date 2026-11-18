'use strict';

/**
 * 根实例
 * ------------------------------------------------------------
 * 负责：环境信息加载、账号/项目列表的共享状态、页面切换、Toast。
 * 页面组件只渲染自己的数据，跨页共享的数据都由这里统一维护与刷新。
 * @author yittiger
 */

/* eslint-disable no-unused-vars */

new Vue({
  el: '#app',

  data() {
    return {
      tab: 'accounts',
      info: null,
      accounts: [],
      projects: [],
      toasts: [],
      toastSeed: 0,
      busy: false,
      gitFocusId: '',
      navs: [
        { key: 'accounts', label: '账号', icon: '⚿', countKey: 'accounts' },
        { key: 'projects', label: '项目', icon: '▤', countKey: 'projects' },
        { key: 'git', label: 'Git 面板', icon: '⌥', countKey: '' },
        { key: 'diagnose', label: '诊断', icon: '◎', countKey: '' },
        { key: 'settings', label: '设置', icon: '⚙', countKey: '' }
      ]
    };
  },

  computed: {
    hasGit() {
      return Boolean(this.info && this.info.versions && this.info.versions.git && this.info.versions.git.available);
    }
  },

  created() {
    this.bootstrap();
  },

  methods: {
    /**
     * 初始化：先拿环境信息，再拉两个列表
     */
    async bootstrap() {
      try {
        const info = await window.gitApi.appInfo();
        if (info.ok) {
          this.info = info;
        } else {
          this.toast('读取环境信息失败：' + (info.error || '未知错误'), 'err');
        }
      } catch (err) {
        this.toast('读取环境信息失败：' + err.message, 'err');
      }
      await Promise.all([this.reloadAccounts(), this.reloadProjects()]);
    },

    /**
     * 刷新全部
     */
    async reloadAll() {
      this.busy = true;
      try {
        const info = await window.gitApi.appInfo();
        if (info.ok) this.info = info;
        await Promise.all([this.reloadAccounts(), this.reloadProjects()]);
      } finally {
        this.busy = false;
      }
    },

    /**
     * 刷新账号列表
     */
    async reloadAccounts() {
      const result = await window.gitApi.accounts.list();
      if (result.ok) {
        this.accounts = result.items;
      } else {
        this.toast('读取账号失败：' + result.error, 'err');
      }
    },

    /**
     * 刷新项目列表
     */
    async reloadProjects() {
      const result = await window.gitApi.projects.list();
      if (result.ok) {
        this.projects = result.items;
      } else {
        this.toast('读取项目失败：' + result.error, 'err');
      }
    },

    /**
     * 切换标签页
     * @param {string} key 页面 key
     */
    switchTab(key) {
      this.tab = key;
    },

    /**
     * 打开指定项目的 Git 面板
     * @param {string} projectId 项目 ID
     */
    openGit(projectId) {
      this.gitFocusId = projectId;
      this.tab = 'git';
    },

    /**
     * 侧边栏计数
     * @param {string} key 计数字段
     * @returns {string|number}
     */
    countOf(key) {
      if (key === 'accounts') return this.accounts.length;
      if (key === 'projects') return this.projects.length;
      return '';
    },

    /**
     * 环境状态文本
     * @param {string} key git / ssh / sshKeygen
     * @returns {string}
     */
    envText(key) {
      if (!this.info || !this.info.versions) return '检测中';
      const item = this.info.versions[key];
      if (!item) return '未知';
      if (key === 'git') {
        if (!item.available) return '未安装';
        const match = String(item.version || '').match(/\d+\.\d+\.\d+/);
        return match ? match[0] : '可用';
      }
      if (key === 'ssh') {
        if (!item.available) return '不可用';
        const match = String(item.version || '').match(/\d+[._]\d+|OpenSSH[_\s]\w+/i);
        return match ? match[0].replace(/_/g, '.') : '可用';
      }
      return item.path ? '可用' : '缺失';
    },

    /**
     * 环境状态样式
     * @param {string} key 同上
     * @returns {string}
     */
    envClass(key) {
      if (!this.info || !this.info.versions) return '';
      const item = this.info.versions[key];
      if (!item) return '';
      const ok = key === 'sshKeygen' ? Boolean(item.path) : Boolean(item.available);
      return ok ? 'ok' : 'err';
    },

    /**
     * 轻提示
     * @param {string} text 文本
     * @param {string} [type] ok / err / info
     */
    toast(text, type) {
      this.toastSeed += 1;
      const item = { id: this.toastSeed, text: String(text || ''), type: type || 'info' };
      this.toasts.push(item);
      const currentId = item.id;
      setTimeout(() => {
        this.toasts = this.toasts.filter((entry) => entry.id !== currentId);
      }, 4000);
      // 最多同时显示 4 条，避免刷屏
      if (this.toasts.length > 4) this.toasts.splice(0, this.toasts.length - 4);
    }
  }
});
