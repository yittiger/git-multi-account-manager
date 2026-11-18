'use strict';

/**
 * Git 操作面板
 * ------------------------------------------------------------
 * 只暴露白名单动作（fetch/pull/push/add/commit/checkout/stash），
 * 自定义命令限定为只读子命令，避免面板成为「任意命令执行」的入口。
 * 命令输出通过主进程流式回传，实时显示在下方终端区。
 * @author yittiger
 */

Vue.component('git-page', {
  props: {
    projects: { type: Array, default: () => [] },
    focusId: { type: String, default: '' }
  },

  data() {
    return {
      selectedId: '',
      runtime: null,
      loading: false,
      error: '',
      branches: [],
      logItems: [],
      commitMessage: '',
      commitAddAll: true,
      outputLines: [],
      running: '',
      customCmd: '',
      branchTarget: ''
    };
  },

  computed: {
    current() {
      return this.projects.find((item) => item.id === this.selectedId) || null;
    },
    hasProject() {
      return Boolean(this.selectedId);
    },
    canUseGit() {
      return Boolean(this.runtime && this.runtime.ok);
    }
  },

  watch: {
    focusId(value) {
      if (value) this.select(value);
    },
    projects(value) {
      // 当前选中的项目被移除后自动切换到第一个
      if (this.selectedId && value.some((item) => item.id === this.selectedId)) return;
      if (value.length) this.select(value[0].id);
      else {
        this.selectedId = '';
        this.runtime = null;
      }
    }
  },

  created() {
    if (this.focusId) this.select(this.focusId);
    else if (this.projects.length) this.select(this.projects[0].id);
  },

  methods: {
    shortPath: G.shortPath,
    fmtTime: G.fmtTime,

    /**
     * 选择项目并刷新
     * @param {string} id 项目 ID
     */
    select(id) {
      this.selectedId = id;
      this.runtime = null;
      this.branches = [];
      this.logItems = [];
      this.outputLines = [];
      this.refresh();
    },

    /**
     * 刷新运行态、分支、历史
     */
    async refresh() {
      if (!this.selectedId) return;
      this.loading = true;
      this.error = '';
      try {
        const runtime = await window.gitApi.projects.runtime(this.selectedId);
        if (!runtime.ok) {
          this.error = runtime.error;
          this.runtime = null;
          return;
        }
        this.runtime = runtime;
        if (!this.branchTarget) this.branchTarget = runtime.branch;

        const branches = await window.gitApi.projects.branches(this.selectedId);
        this.branches = branches.ok ? branches.items : [];

        const logs = await window.gitApi.projects.log({ id: this.selectedId, count: 30 });
        this.logItems = logs.ok ? logs.items : [];
      } catch (err) {
        this.error = err.message;
      } finally {
        this.loading = false;
      }
    },

    /**
     * 向终端追加一行
     * @param {string} cls 样式类
     * @param {string} text 文本
     */
    pushLine(cls, text) {
      if (!text) return;
      this.outputLines.push({ cls: cls, text: text });
      this.$nextTick(() => {
        const el = this.$refs.terminal;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    /**
     * 执行动作（流式）
     * @param {string} action 动作名
     * @param {object} [extra] 附加参数
     */
    async run(action, extra) {
      if (!this.selectedId || this.running) return;
      this.running = action;
      const reqId = G.reqId();
      this.pushLine('sys', '\n$ 准备执行：' + action);

      await new Promise((resolve) => {
        window.gitApi.git.run(
          { reqId: reqId, projectId: this.selectedId, action: action, extra: extra || {} },
          (start) => this.pushLine('cmd', '$ ' + start.command),
          (stream, text) => this.pushLine(stream === 'stderr' ? 'err' : '', text),
          (result) => {
            if (result.ok) {
              this.pushLine('sys', '✓ 完成（' + Math.round(result.duration / 100) / 10 + 's）');
            } else {
              const message = result.error || result.stderr || result.stdout || ('退出码 ' + result.code);
              this.pushLine('err', '✗ 失败：' + String(message).trim());
              this.$root.toast('操作失败：' + String(message).trim().split('\n')[0], 'err');
            }
            resolve();
          }
        );
      });

      this.running = '';
      this.refresh();
    },

    /**
     * 提交
     */
    async commit() {
      if (!this.commitMessage.trim()) {
        this.$root.toast('请填写提交信息', 'err');
        return;
      }
      await this.run('commit', { message: this.commitMessage.trim(), addAll: this.commitAddAll });
      this.commitMessage = '';
    },

    /**
     * 切换分支
     */
    async checkout() {
      if (!this.branchTarget) return;
      await this.run('checkout', { branch: this.branchTarget });
    },

    /**
     * 设置上游并推送
     */
    async pushUpstream() {
      if (!this.runtime || !this.runtime.branch) {
        this.$root.toast('当前不在正常分支上', 'err');
        return;
      }
      await this.run('pushSetUpstream', { branch: this.runtime.branch, remote: 'origin' });
    },

    /**
     * 执行自定义只读命令
     */
    async runCustom() {
      const text = this.customCmd.trim();
      if (!text) return;
      // 用空格切分；带引号的参数这里不做复杂解析，仅支持简单命令
      const args = text.split(/\s+/);
      await this.run('custom', { args: args });
    },

    /**
     * 切换回项目当前分支（下拉框复位）
     */
    resetBranchTarget() {
      if (this.runtime && this.runtime.branch) this.branchTarget = this.runtime.branch;
    },

    /**
     * 清空终端
     */
    clearTerminal() {
      this.outputLines = [];
    },

    /**
     * 复制终端内容
     */
    async copyTerminal() {
      const text = this.outputLines.map((line) => line.text).join('');
      const ok = await G.copy(text);
      this.$root.toast(ok ? '输出已复制' : '复制失败', ok ? 'ok' : 'err');
    },

    /**
     * 打开项目目录
     */
    async openFolder() {
      if (!this.current) return;
      const result = await window.gitApi.system.openPath(this.current.path);
      if (!result.ok) this.$root.toast(result.error, 'err');
    }
  },

  template: `
    <div>
      <div class="toolbar">
        <div class="toolbar-title">Git 面板</div>
        <select class="select" style="width:300px" v-model="selectedId" @change="select(selectedId)">
          <option value="">选择项目</option>
          <option v-for="project in projects" :key="project.id" :value="project.id">
            {{ project.name }} — {{ project.accountLabel || '未绑定账号' }}
          </option>
        </select>
        <button class="btn ghost sm" @click="refresh" :disabled="!hasProject || loading">
          {{ loading ? '读取中…' : '刷新' }}
        </button>
        <button class="btn ghost sm" @click="openFolder" :disabled="!hasProject">打开目录</button>
        <div class="spacer"></div>
        <span class="badge info" v-if="runtime && runtime.account">{{ runtime.account.label }} · {{ runtime.account.alias }}</span>
      </div>

      <ui-empty v-if="!projects.length" icon="⌥" text="还没有项目，请先到「项目」页添加仓库">
        <button class="btn sm mt8" @click="$root.switchTab('projects')">去添加项目</button>
      </ui-empty>

      <div v-else-if="error" class="banner err">
        <span>{{ error }}</span>
        <div class="spacer"></div>
        <button class="btn sm" @click="refresh">重试</button>
      </div>

      <div v-else-if="!hasProject" class="empty">请选择左侧下拉框中的一个项目</div>

      <div v-else-if="runtime && runtime.ok">
        <div class="git-status-bar mb12">
          <span class="git-branch">⎇ {{ runtime.branch }}</span>
          <span class="ab-pill">
            <span>领先 <b>{{ runtime.ahead }}</b></span>
            <span>落后 <i>{{ runtime.behind }}</i></span>
          </span>
          <span class="badge" :class="runtime.dirtyCount ? 'warn' : 'ok'">
            {{ runtime.dirtyCount ? '变更 ' + runtime.dirtyCount + ' 个文件' : '工作区干净' }}
          </span>
          <span class="badge" v-if="runtime.noUpstream" :class="'err'">无上游</span>
          <span class="badge" v-if="runtime.detached">detached HEAD</span>
          <div class="spacer"></div>
          <span class="small faint mono-text">{{ runtime.identity.name || '身份未设置' }} &lt;{{ runtime.identity.email || '未设置' }}&gt;</span>
        </div>

        <div class="git-layout">
          <div class="git-col">
            <div class="card">
              <div class="card-head">操作</div>
              <div class="card-body">
                <div class="mb12" style="display:flex;gap:8px;flex-wrap:wrap">
                  <button class="btn sm" @click="run('fetch')" :disabled="running">Fetch</button>
                  <button class="btn sm" @click="run('pull')" :disabled="running">Pull</button>
                  <button class="btn sm primary" @click="run('push')" :disabled="running">Push</button>
                  <button class="btn sm" @click="run('add')" :disabled="running">暂存全部</button>
                  <button class="btn sm" v-if="runtime.noUpstream" @click="pushUpstream" :disabled="running">设置上游并推送</button>
                  <button class="btn sm" @click="run('stash')" :disabled="running">Stash</button>
                  <button class="btn sm" @click="run('stashPop')" :disabled="running">Stash pop</button>
                </div>

                <div class="commit-form">
                  <input class="input" v-model="commitMessage" placeholder="提交信息，例如 feat: 新增账号诊断"
                         @keyup.enter.ctrl="commit">
                  <button class="btn primary" @click="commit" :disabled="running">提交</button>
                </div>
                <label class="checkbox mt8">
                  <input type="checkbox" v-model="commitAddAll">
                  <span>提交时自动包含已跟踪文件的修改（git commit -a）</span>
                </label>

                <div class="input-row mt12">
                  <select class="select" v-model="branchTarget">
                    <option v-for="branch in branches" :key="branch.name" :value="branch.name">
                      {{ branch.name }}{{ branch.isRemote ? '（远程）' : '' }}
                    </option>
                  </select>
                  <button class="btn sm" @click="checkout" :disabled="running || !branchTarget">切换分支</button>
                </div>

                <div class="input-row mt8">
                  <input class="input" v-model="customCmd" placeholder="只读命令，例如 log --oneline -5"
                         @keyup.enter="runCustom">
                  <button class="btn sm" @click="runCustom" :disabled="running">执行</button>
                </div>
                <div class="hint mt8">自定义命令仅允许 status / log / diff / show / remote / branch / config / rev-parse / describe / ls-files / blame / tag。</div>
              </div>
            </div>

            <div class="card">
              <div class="card-head">
                <span>输出</span>
                <span class="badge info" v-if="running">{{ running }} 执行中…</span>
                <div class="spacer"></div>
                <button class="btn xs ghost" @click="copyTerminal">复制</button>
                <button class="btn xs ghost" @click="clearTerminal">清空</button>
              </div>
              <div class="card-body" style="padding:10px">
                <div class="terminal" ref="terminal">
                  <span v-if="!outputLines.length" class="sys">等待操作…</span>
                  <span v-for="(line, index) in outputLines" :key="index" :class="line.cls">{{ line.text }}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="git-col">
            <div class="card">
              <div class="card-head">
                <span>工作区变更</span>
                <span class="badge" :class="runtime.dirtyCount ? 'warn' : 'ok'">{{ runtime.dirtyCount }}</span>
              </div>
              <div class="card-body" style="padding:10px 14px">
                <div class="file-list">
                  <div class="file-item" v-for="file in runtime.changedFiles" :key="file.file">
                    <span class="st">{{ file.status }}</span>
                    <span :title="file.file">{{ shortPath(file.file, 60) }}</span>
                  </div>
                </div>
                <div class="hint" v-if="!runtime.changedFiles.length">没有未提交的变更</div>
              </div>
            </div>

            <div class="card">
              <div class="card-head">
                <span>分支</span>
                <span class="badge">{{ branches.length }}</span>
              </div>
              <div class="branch-list">
                <div v-for="branch in branches" :key="branch.name" class="branch-item">
                  <span class="name">{{ branch.name }}</span>
                  <span class="hash">{{ branch.hash }}</span>
                  <span class="faint small">{{ branch.date }}</span>
                </div>
              </div>
            </div>

            <div class="card">
              <div class="card-head">
                <span>提交历史</span>
                <span class="badge">{{ logItems.length }}</span>
              </div>
              <div class="log-list">
                <div v-for="item in logItems" :key="item.hash" class="log-item">
                  <span class="log-hash">{{ item.hash }}</span>
                  <span class="log-subject" :title="item.subject">{{ item.subject }}</span>
                  <span class="log-author" :title="item.author + ' <' + item.email + '>'">{{ item.author }}</span>
                </div>
                <div class="hint" v-if="!logItems.length" style="padding:10px 14px">还没有提交记录</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
});
