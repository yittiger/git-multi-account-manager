'use strict';

/**
 * 设置页
 * ------------------------------------------------------------
 * 手动指定 git / ssh / ssh-keygen 路径（应对「装了但不在 PATH」的情况），
 * 并把配置文件位置、探测结果摊开展示，方便排查。
 * @author yittiger
 */

Vue.component('settings-page', {
  props: { info: { type: Object, default: null } },

  data() {
    return {
      form: {
        gitPath: '',
        sshPath: '',
        sshKeygenPath: '',
        defaultKeyType: 'ed25519',
        scanDepth: 3
      },
      saving: false,
      probing: false
    };
  },

  computed: {
    versions() {
      return (this.info && this.info.versions) || null;
    },
    paths() {
      return (this.info && this.info.paths) || {};
    },
    keyTypes() {
      return (this.info && this.info.keyTypes) || [];
    }
  },

  created() {
    this.syncForm();
  },

  watch: {
    info() {
      this.syncForm();
    }
  },

  methods: {
    /**
     * 把当前设置回填到表单
     */
    syncForm() {
      if (!this.info || !this.info.settings) return;
      this.form = {
        gitPath: this.info.settings.gitPath || '',
        sshPath: this.info.settings.sshPath || '',
        sshKeygenPath: this.info.settings.sshKeygenPath || '',
        defaultKeyType: this.info.settings.defaultKeyType || 'ed25519',
        scanDepth: this.info.settings.scanDepth || 3
      };
    },

    /**
     * 保存设置并重新探测
     */
    async save() {
      this.saving = true;
      try {
        const result = await window.gitApi.settings.save({
          gitPath: this.form.gitPath.trim(),
          sshPath: this.form.sshPath.trim(),
          sshKeygenPath: this.form.sshKeygenPath.trim(),
          defaultKeyType: this.form.defaultKeyType,
          scanDepth: Number(this.form.scanDepth) || 3
        });
        if (!result.ok) {
          this.$root.toast(result.error, 'err');
          return;
        }
        this.$root.toast('设置已保存，正在重新探测环境', 'ok');
        this.$emit('refresh');
      } catch (err) {
        this.$root.toast(err.message, 'err');
      } finally {
        this.saving = false;
      }
    },

    /**
     * 清空手动路径，回到自动探测
     */
    async reset() {
      this.saving = true;
      try {
        await window.gitApi.settings.reset();
        this.$root.toast('已恢复自动探测', 'ok');
        this.$emit('refresh');
      } finally {
        this.saving = false;
      }
    },

    /**
     * 打开路径所在目录
     * @param {string} target 文件或目录
     */
    async openPath(target) {
      if (!target) return;
      const result = await window.gitApi.system.openPath(target);
      if (!result.ok) this.$root.toast(result.error, 'err');
    },

    /**
     * 在资源管理器中定位文件
     * @param {string} target 文件路径
     */
    async reveal(target) {
      if (!target) return;
      const result = await window.gitApi.system.reveal(target);
      if (!result.ok) {
        // 文件还不存在时退化为打开所在目录
        const dir = String(target).replace(/[\\/][^\\/]*$/, '');
        if (dir) await window.gitApi.system.openPath(dir);
      }
    },

    shortPath: G.shortPath
  },

  template: `
    <div>
      <div class="toolbar">
        <div class="toolbar-title">设置</div>
        <span class="toolbar-sub">可执行文件路径与探测结果</span>
        <div class="spacer"></div>
        <button class="btn ghost sm" @click="reset" :disabled="saving">恢复自动探测</button>
        <button class="btn primary sm" @click="save" :disabled="saving">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>

      <div class="card mb12">
        <div class="card-head">可执行文件路径</div>
        <div class="card-body">
          <div class="field">
            <label>git.exe</label>
            <input class="input" v-model="form.gitPath" placeholder="留空自动探测，例如 C:\\Program Files\\Git\\cmd\\git.exe">
            <span class="hint" v-if="versions && versions.git.path">
              当前探测到：{{ versions.git.path }}
            </span>
            <span class="hint err" v-else>未探测到 git，请安装 Git for Windows 或手动填写路径</span>
          </div>
          <div class="field">
            <label>ssh.exe</label>
            <input class="input" v-model="form.sshPath" placeholder="留空自动探测，例如 C:\\Windows\\System32\\OpenSSH\\ssh.exe">
            <span class="hint" v-if="versions && versions.ssh.path">当前探测到：{{ versions.ssh.path }}</span>
            <span class="hint err" v-else>未探测到 ssh，请启用 Windows OpenSSH 客户端</span>
          </div>
          <div class="field">
            <label>ssh-keygen.exe</label>
            <input class="input" v-model="form.sshKeygenPath" placeholder="留空自动探测">
            <span class="hint" v-if="versions && versions.sshKeygen.path">当前探测到：{{ versions.sshKeygen.path }}</span>
            <span class="hint err" v-else>未探测到 ssh-keygen，无法在应用内生成密钥</span>
          </div>
          <div class="grid-2">
            <div class="field">
              <label>默认密钥算法</label>
              <select class="select" v-model="form.defaultKeyType">
                <option v-for="item in keyTypes" :key="item.id" :value="item.id">{{ item.label }}</option>
              </select>
            </div>
            <div class="field">
              <label>扫描仓库默认层数</label>
              <input class="input" type="number" min="1" max="6" v-model.number="form.scanDepth">
            </div>
          </div>
        </div>
      </div>

      <div class="card mb12">
        <div class="card-head">文件位置</div>
        <div class="card-body">
          <div class="kv-list">
            <div class="kv-row">
              <span class="k">应用配置</span>
              <span class="v">{{ paths.configFile }}</span>
              <button class="btn xs ghost" @click="reveal(paths.configFile)">定位</button>
              <button class="btn xs ghost" @click="openPath(paths.appDir)">打开目录</button>
            </div>
            <div class="kv-row">
              <span class="k">SSH 配置</span>
              <span class="v">{{ paths.sshConfig }}</span>
              <button class="btn xs ghost" @click="reveal(paths.sshConfig)">定位</button>
            </div>
            <div class="kv-row">
              <span class="k">SSH 目录</span>
              <span class="v">{{ paths.sshDir }}</span>
              <button class="btn xs ghost" @click="openPath(paths.sshDir)">打开目录</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">探测结果</div>
        <div class="card-body" v-if="versions">
          <div class="kv-list">
            <div class="kv-row">
              <span class="k">Git</span>
              <span class="v">
                <span class="badge" :class="versions.git.available ? 'ok' : 'err'">{{ versions.git.available ? '可用' : '不可用' }}</span>
                {{ versions.git.version || versions.git.error }}
              </span>
            </div>
            <div class="kv-row">
              <span class="k">SSH</span>
              <span class="v">
                <span class="badge" :class="versions.ssh.available ? 'ok' : 'err'">{{ versions.ssh.available ? '可用' : '不可用' }}</span>
                {{ versions.ssh.version || versions.ssh.error }}
              </span>
            </div>
            <div class="kv-row">
              <span class="k">ssh-keygen</span>
              <span class="v">
                <span class="badge" :class="versions.sshKeygen.path ? 'ok' : 'err'">{{ versions.sshKeygen.path ? '可用' : '不可用' }}</span>
                {{ versions.sshKeygen.path || versions.sshKeygen.error }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div class="hint mt16">
        说明：本工具不会修改 git 的全局配置，所有提交身份都写在各自仓库的 .git/config（local 级），
        卸载或删除本工具不会影响已有仓库。
      </div>
    </div>
  `
});
