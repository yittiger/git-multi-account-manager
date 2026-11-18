'use strict';

/**
 * 通用 UI 组件与全局辅助函数
 * ------------------------------------------------------------
 * 这里只放跨页面复用的东西：弹窗、Toast、空状态、以及一些纯函数。
 * 页面自己的逻辑放 pages/ 下，避免一个文件越写越长。
 * @author yittiger
 */

/* eslint-disable no-unused-vars */

/**
 * 通用弹窗
 * 用法：<ui-modal :visible="..." title="..." @close="...">内容<template #footer>按钮</template></ui-modal>
 */
Vue.component('ui-modal', {
  props: {
    visible: { type: Boolean, default: false },
    title: { type: String, default: '' },
    width: { type: String, default: '640px' },
    maskClose: { type: Boolean, default: true }
  },
  methods: {
    /**
     * 点击遮罩关闭
     * @param {MouseEvent} event 事件
     */
    onMask(event) {
      if (this.maskClose && event.target === event.currentTarget) this.$emit('close');
    }
  },
  template:
    '<div class="modal-mask" v-if="visible" @mousedown="onMask">' +
      '<div class="modal-box" :style="{ width: width }">' +
        '<div class="modal-head">' +
          '<span>{{ title }}</span>' +
          '<button class="close" @click="$emit(\'close\')" title="关闭">×</button>' +
        '</div>' +
        '<div class="modal-body"><slot></slot></div>' +
        '<div class="modal-foot" v-if="hasFooter"><slot name="footer"></slot></div>' +
      '</div>' +
    '</div>',
  computed: {
    hasFooter() {
      return Boolean(this.$slots && this.$slots.footer);
    }
  }
});

/**
 * Toast 容器
 */
Vue.component('ui-toast', {
  props: { items: { type: Array, default: () => [] } },
  template:
    '<div class="toast-host">' +
      '<div v-for="item in items" :key="item.id" :class="[\'toast\', item.type]">{{ item.text }}</div>' +
    '</div>'
});

/**
 * 空状态占位
 */
Vue.component('ui-empty', {
  props: { text: { type: String, default: '暂无数据' }, icon: { type: String, default: '◇' } },
  template:
    '<div class="empty">' +
      '<span class="empty-icon">{{ icon }}</span>' +
      '<div>{{ text }}</div>' +
      '<div v-if="hasSlot"><slot></slot></div>' +
    '</div>',
  computed: {
    hasSlot() {
      return Boolean(this.$slots && this.$slots.default);
    }
  }
});

/**
 * 全局辅助函数集合
 */
window.G = {
  /**
   * 复制文本到剪贴板
   * @param {string} text 文本
   * @returns {Promise<boolean>}
   */
  async copy(text) {
    const result = await window.gitApi.system.copy(text || '');
    return Boolean(result && result.ok);
  },

  /**
   * 路径截断（保留头尾，中间省略）
   * @param {string} value 路径
   * @param {number} [max] 最大长度
   * @returns {string}
   */
  shortPath(value, max) {
    const text = String(value || '');
    const limit = max || 46;
    if (text.length <= limit) return text;
    const headLength = Math.floor(limit * 0.42);
    const tailLength = limit - headLength - 1;
    return text.slice(0, headLength) + '…' + text.slice(text.length - tailLength);
  },

  /**
   * 首字母（用于账号头像）
   * @param {string} label 名称
   * @returns {string}
   */
  initial(label) {
    const text = String(label || '?').trim();
    if (!text) return '?';
    return /^[a-zA-Z]/.test(text) ? text.slice(0, 1).toUpperCase() : text.slice(0, 1);
  },

  /**
   * 时间格式化
   * @param {string|number} value 时间
   * @returns {string}
   */
  fmtTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  },

  /**
   * 统一处理 IPC 返回结果：失败时抛出，成功时返回值
   * @param {object} result IPC 结果
   * @returns {object}
   */
  ensure(result) {
    if (!result) throw new Error('主进程无返回');
    if (result.ok === false) throw new Error(result.error || '操作失败');
    return result;
  },

  /**
   * 生成请求 ID（流式命令用）
   * @returns {string}
   */
  reqId() {
    return 'req_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  },

  /**
   * 深拷贝（配置对象简单，JSON 足够）
   * @param {object} value 原对象
   * @returns {object}
   */
  clone(value) {
    return JSON.parse(JSON.stringify(value));
  }
};
