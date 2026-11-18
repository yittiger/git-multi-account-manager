'use strict';

/**
 * 诊断页
 * ------------------------------------------------------------
 * 把「多账号串号」的常见成因一次扫出来，能自动修的直接给按钮。
 * 结果按 环境 / 全局 / 账号 / 项目 四组展示。
 * @author yittiger
 */

Vue.component('diagnose-page', {
  props: {
    accounts: { type: Array, default: () => [] },
    projects: { type: Array, default: () => [] }
  },

  data() {
    return {
      result: null,
      running: false,
      testConnections: true,
      fixingId: '',
      error: ''
    };
  },

  computed: {
    groups() {
      if (!this.result) return [];
      const scopes = [
        { key: 'env', label: '环境' },
        { key: 'global', label: '全局配置' },
        { key: 'account', label: '账号' },
        { key: 'project', label: '项目' }
      ];
      return scopes
        .map((scope) => ({
          key: scope.key,
          label: scope.label,
          items: this.result.items.filter((item) => item.scope === scope.key)
        }))
        .filter((group) => group.items.length);
    },
    summary() {
      return (this.result && this.result.summary) || { error: 0, warn: 0, ok: 0, info: 0 };
    },
    generatedAtText() {
      return this.result ? G.fmtTime(this.result.generatedAt) : '';
    }
  },

  created() {
    this.run();
  },

  methods: {
    /**
     * 执行诊断
     */
    async run() {
      if (this.running) return;
      this.running = true;
      this.error = '';
      try {
        const result = await window.gitApi.diagnose.run({ testConnections: this.testConnections });
        if (!result.ok) {
          this.error = result.error;
          return;
        }
        this.result = result;
      } catch (err) {
        this.error = err.message;
      } finally {
        this.running = false;
      }
    },

    /**
     * 执行修复
     * @param {object} item 诊断项
     */
    async applyFix(item) {
      if (!item.fix) return;
      const action = item.fix.action;

      if (action === 'openSettings') {
        this.$root.switchTab('settings');
        return;
      }
      if (action === 'openBind') {
        this.$root.switchTab('projects');
        this.$root.toast('请在该项目的「绑定账号」里完成设置', 'info');
        return;
      }

      const payload = { action: action };
      if (action === 'applySshConfig' || action === 'generateKey' ||
          action === 'applyDomainMapping' || action === 'removeDomainMapping') {
        payload.accountId = item.targetId;
      }
      if (action === 'bind' || action === 'removeProject') {
        payload.projectId = item.targetId;
        const project = this.projects.find((entry) => entry.id === item.targetId);
        payload.accountId = project ? project.accountId : '';
        if (action === 'bind' && !payload.accountId) {
          this.$root.toast('该项目还没有绑定账号，请先在项目页绑定', 'err');
          return;
        }
      }

      this.fixingId = item.id || item.title;
      try {
        const result = await window.gitApi.diagnose.fix(payload);
        if (!result.ok) {
          const failed = (result.steps || []).filter((step) => !step.ok).map((step) => step.name + '：' + step.message);
          this.$root.toast(failed.join('；') || result.error || '修复失败', 'err');
          return;
        }
        this.$root.toast('已修复：' + item.title, 'ok');
        await this.run();
        this.$emit('refresh');
      } catch (err) {
        this.$root.toast(err.message, 'err');
      } finally {
        this.fixingId = '';
      }
    },

    /**
     * 复制诊断报告
     */
    async copyReport() {
      if (!this.result) return;
      const lines = [];
      lines.push('Git 多账号配置诊断报告 ' + this.generatedAtText);
      lines.push('错误 ' + this.summary.error + ' / 警告 ' + this.summary.warn +
        ' / 正常 ' + this.summary.ok + ' / 提示 ' + this.summary.info);
      this.groups.forEach((group) => {
        lines.push('');
        lines.push('【' + group.label + '】');
        group.items.forEach((item) => {
          lines.push('[' + item.level.toUpperCase() + '] ' + item.title +
            (item.targetLabel ? ' — ' + item.targetLabel : ''));
          if (item.detail) lines.push('    ' + String(item.detail).replace(/\n/g, '\n    '));
        });
      });
      const ok = await G.copy(lines.join('\n'));
      this.$root.toast(ok ? '报告已复制到剪贴板' : '复制失败', ok ? 'ok' : 'err');
    },

    /**
     * 等级显示文本
     * @param {string} level 等级
     * @returns {string}
     */
    levelText(level) {
      const map = { error: '错误', warn: '警告', ok: '正常', info: '提示' };
      return map[level] || level;
    },

    shortPath: G.shortPath
  },

  template: `
    <div>
      <div class="toolbar">
        <div class="toolbar-title">诊断</div>
        <span class="toolbar-sub" v-if="generatedAtText">上次检测 {{ generatedAtText }}</span>
        <div class="spacer"></div>
        <label class="checkbox">
          <input type="checkbox" v-model="testConnections">
          <span>包含 SSH 连通测试（较慢）</span>
        </label>
        <button class="btn ghost sm" @click="copyReport" :disabled="!result">复制报告</button>
        <button class="btn primary sm" @click="run" :disabled="running">
          {{ running ? '检测中…' : '重新检测' }}
        </button>
      </div>

      <div class="banner err" v-if="error">{{ error }}</div>

      <div v-if="running && !result" class="empty">正在检测环境、账号与项目…</div>

      <div v-if="result">
        <div class="diag-summary">
          <div class="summary-card err">
            <div class="num">{{ summary.error }}</div>
            <div class="lbl">错误（必须处理）</div>
          </div>
          <div class="summary-card warn">
            <div class="num">{{ summary.warn }}</div>
            <div class="lbl">警告（存在串号风险）</div>
          </div>
          <div class="summary-card ok">
            <div class="num">{{ summary.ok }}</div>
            <div class="lbl">正常</div>
          </div>
          <div class="summary-card info">
            <div class="num">{{ summary.info }}</div>
            <div class="lbl">提示</div>
          </div>
        </div>

        <div class="diag-group" v-for="group in groups" :key="group.key">
          <div class="diag-group-title">
            {{ group.label }}
            <span class="badge">{{ group.items.length }}</span>
          </div>
          <div v-for="(item, index) in group.items" :key="group.key + index" class="diag-row" :class="item.level">
            <span class="diag-level">{{ levelText(item.level) }}</span>
            <div class="diag-main">
              <div class="diag-title">
                <span>{{ item.title }}</span>
                <span class="diag-target" v-if="item.targetLabel">{{ item.targetLabel }}</span>
              </div>
              <div class="diag-detail" v-if="item.detail">{{ item.detail }}</div>
            </div>
            <button class="btn xs" v-if="item.fix" @click="applyFix(item)"
                    :disabled="fixingId === (item.id || item.title)">
              {{ item.fix.label }}
            </button>
          </div>
        </div>
      </div>

      <div class="hint mt16" v-if="result && result.versions">
        探测结果：git={{ result.versions.git.path || '未找到' }} · ssh={{ result.versions.ssh.path || '未找到' }}
        · ssh-keygen={{ result.versions.sshKeygen.path || '未找到' }}
      </div>
    </div>
  `
});
