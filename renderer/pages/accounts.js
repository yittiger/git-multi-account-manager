'use strict';

/**
 * 账号页
 * ------------------------------------------------------------
 * 职责：账号增删改、SSH 密钥生成/导入、ssh config 写入、连通性测试。
 * 页面本身不直接接触文件系统，全部通过 preload 暴露的 gitApi 调用主进程。
 * @author yittiger
 */

Vue.component('accounts-page', {
  props: {
    accounts: { type: Array, default: () => [] },
    info: { type: Object, default: null }
  },

  data() {
    return {
      form: {
        visible: false,
        mode: 'create',
        saving: false,
        generateKey: true,
        forceKey: false,
        errors: {},
        data: this.emptyForm()
      },
      pub: { visible: false, title: '', value: '', file: '' },
      block: { visible: false, title: '', block: '', inspect: null },
      keyPicker: { visible: false, items: [], loading: false },
      removeModal: { visible: false, account: null, removeSshBlock: true, keepKeyFiles: true, running: false },
      testResults: {},
      testing: {},
      busyAll: false
    };
  },

  computed: {
    providers() {
      return (this.info && this.info.providers) || [];
    },
    keyTypes() {
      return (this.info && this.info.keyTypes) || [];
    },
    providerLabelMap() {
      const map = {};
      this.providers.forEach((item) => {
        map[item.id] = item.label;
      });
      return map;
    }
  },

  methods: {
    /**
     * 表单初始结构
     * @returns {object}
     */
    emptyForm() {
      return {
        id: '',
        label: '',
        provider: 'gitee',
        hostName: 'gitee.com',
        port: 22,
        alias: '',
        sshUser: 'git',
        userName: '',
        userEmail: '',
        keyType: 'ed25519',
        keyPath: '',
        note: ''
      };
    },

    /**
     * 新建账号
     */
    openCreate() {
      this.form.visible = true;
      this.form.mode = 'create';
      this.form.errors = {};
      this.form.data = this.emptyForm();
      this.form.generateKey = true;
      this.form.forceKey = false;
      this.form.data.alias = this.suggestAlias(this.form.data.provider, '');
    },

    /**
     * 编辑账号
     * @param {object} account 账号
     */
    openEdit(account) {
      this.form.visible = true;
      this.form.mode = 'edit';
      this.form.errors = {};
      this.form.data = {
        id: account.id,
        label: account.label,
        provider: account.provider,
        hostName: account.hostName,
        port: account.port || 22,
        alias: account.alias,
        sshUser: account.sshUser || 'git',
        userName: account.userName,
        userEmail: account.userEmail,
        keyType: account.keyType || 'ed25519',
        keyPath: account.keyPath,
        note: account.note || ''
      };
      this.form.generateKey = false;
      this.form.forceKey = false;
    },

    /**
     * 根据平台与名称推荐一个未被占用的别名
     * @param {string} provider 平台 ID
     * @param {string} label 账号名称
     * @returns {string}
     */
    suggestAlias(provider, label) {
      const ascii = String(label || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const base = (provider === 'custom' ? 'git' : provider.replace(/-enterprise$/, '')) + '-' + (ascii || 'work');
      const used = this.accounts.map((item) => String(item.alias).toLowerCase());
      let candidate = base;
      let index = 2;
      while (used.indexOf(candidate) >= 0) {
        candidate = base + index;
        index += 1;
      }
      return candidate;
    },

    /**
     * 平台切换时同步域名与别名
     * @param {string} providerId 平台 ID
     */
    onProviderChange(providerId) {
      const preset = this.providers.find((item) => item.id === providerId);
      if (preset && preset.hostName) {
        this.form.data.hostName = preset.hostName;
      }
      if (preset) this.form.data.sshUser = preset.sshUser || 'git';
      if (!this.form.data.alias) {
        this.form.data.alias = this.suggestAlias(providerId, this.form.data.label);
      }
    },

    /**
     * 名称变化时，如果别名还是空的就自动跟随
     */
    onLabelBlur() {
      if (this.form.mode === 'create' && !this.form.data.alias) {
        this.form.data.alias = this.suggestAlias(this.form.data.provider, this.form.data.label);
      }
    },

    /**
     * 提交表单
     */
    async submit() {
      if (this.form.saving) return;
      this.form.saving = true;
      this.form.errors = {};
      try {
        const result = await window.gitApi.accounts.save(this.form.data);
        if (!result.ok) {
          this.form.errors = result.errors || { _: result.error || '保存失败' };
          return;
        }

        const account = result.account;

        if (this.form.generateKey) {
          const keyResult = await window.gitApi.accounts.generateKey({
            id: account.id,
            force: this.form.forceKey
          });
          if (!keyResult.ok) {
            this.$root.toast('账号已保存，但密钥生成失败：' + keyResult.error, 'err');
          } else {
            this.$root.toast('已生成密钥：' + account.keyPath, 'ok');
          }
        }

        // 新建/编辑后顺手把 ssh config 写好，省一步
        const applyResult = await window.gitApi.accounts.applySshConfig(account.id);
        if (applyResult.ok) {
          this.$root.toast(applyResult.changed ? '已写入 ~/.ssh/config' : 'SSH 配置已是最新', 'ok');
        } else {
          this.$root.toast('SSH 配置写入失败：' + applyResult.error, 'err');
        }

        this.form.visible = false;
        this.$emit('refresh');
      } catch (err) {
        this.form.errors = { _: err.message };
      } finally {
        this.form.saving = false;
      }
    },

    /**
     * 生成密钥（列表卡片入口）
     * @param {object} account 账号
     */
    async generate(account) {
      this.testing['key:' + account.id] = true;
      try {
        const result = await window.gitApi.accounts.generateKey({
          id: account.id,
          force: account.keyExists
        });
        if (!result.ok) {
          this.$root.toast(result.error, 'err');
        } else {
          this.$root.toast(result.forced ? '已重新生成密钥（旧文件已备份）' : '密钥生成成功', 'ok');
          this.$emit('refresh');
          this.showPub(account);
        }
      } finally {
        this.testing['key:' + account.id] = false;
      }
    },

    /**
     * 查看并复制公钥
     * @param {object} account 账号
     */
    async showPub(account) {
      const result = await window.gitApi.accounts.publicKey(account.id);
      if (!result.ok) {
        this.$root.toast(result.error, 'err');
        return;
      }
      this.pub.visible = true;
      this.pub.title = account.label + ' 的公钥';
      this.pub.value = result.value;
      this.pub.file = result.file;
    },

    /**
     * 复制公钥到剪贴板
     * @param {object} account 账号
     */
    async copyPub(account) {
      const result = await window.gitApi.accounts.publicKey(account.id);
      if (!result.ok) {
        this.$root.toast(result.error, 'err');
        return;
      }
      const copied = await G.copy(result.value);
      this.$root.toast(copied ? '公钥已复制，去平台 SSH Keys 页面粘贴' : '复制失败', copied ? 'ok' : 'err');
    },

    /**
     * 写入该账号的 ssh config 块
     * @param {object} account 账号
     */
    async applyConfig(account) {
      const result = await window.gitApi.accounts.applySshConfig(account.id);
      if (!result.ok) {
        this.$root.toast(result.error, 'err');
        return;
      }
      this.$root.toast(result.changed ? '已写入 ~/.ssh/config' : '配置已是最新，无需改动', 'ok');
      this.$emit('refresh');
    },

    /**
     * 生成/重写「真实域名兜底映射」
     * 让 git@github.com:owner/repo.git 这类裸域名地址也能直接用本账号私钥
     * @param {object} account 账号
     */
    async applyDomain(account) {
      const result = await window.gitApi.accounts.applyDomainMapping(account.id);
      if (!result.ok) {
        this.$root.toast(result.error, 'err');
        return;
      }
      this.$root.toast(result.detail && result.detail.changed
        ? '已写入 Host ' + account.hostName + ' 兜底映射'
        : '域名兜底映射已是最新', 'ok');
      this.$emit('refresh');
    },

    /**
     * 批量写入全部账号
     */
    async applyAll() {
      if (!this.accounts.length) {
        this.$root.toast('还没有账号', 'err');
        return;
      }
      this.busyAll = true;
      try {
        const result = await window.gitApi.accounts.applyAll();
        if (!result.ok) {
          this.$root.toast(result.error, 'err');
          return;
        }
        const changed = result.results.filter((item) => item.changed).length;
        this.$root.toast('已处理 ' + result.results.length + ' 个账号，更新 ' + changed + ' 个配置块', 'ok');
        this.$emit('refresh');
      } finally {
        this.busyAll = false;
      }
    },

    /**
     * 测试单个账号连通性
     * @param {object} account 账号
     */
    async testOne(account) {
      if (this.testing[account.id]) return;
      this.$set(this.testing, account.id, true);
      this.$set(this.testResults, account.id, { level: 'info', message: '正在连接…' });
      try {
        const result = await window.gitApi.accounts.test(account.id);
        this.$set(this.testResults, account.id, result);
        this.$root.toast(account.alias + '：' + result.message, result.ok ? 'ok' : 'err');
      } catch (err) {
        this.$set(this.testResults, account.id, { level: 'err', message: err.message });
      } finally {
        this.$set(this.testing, account.id, false);
      }
    },

    /**
     * 全部测试
     */
    async testAll() {
      for (const account of this.accounts) {
        // 顺序执行，避免同时开一堆 ssh 连接被平台限流
        await this.testOne(account);
      }
    },

    /**
     * 查看 ssh config 块
     * @param {object} account 账号
     */
    async showBlock(account) {
      const result = await window.gitApi.accounts.previewBlock(account.id);
      if (!result.ok) {
        this.$root.toast(result.error, 'err');
        return;
      }
      this.block.visible = true;
      this.block.title = 'ssh config 块 · ' + account.alias;
      this.block.block = result.block;
      this.block.inspect = result.inspect;
    },

    /**
     * 打开已有密钥选择器
     */
    async openKeyPicker() {
      this.keyPicker.visible = true;
      this.keyPicker.loading = true;
      try {
        const result = await window.gitApi.accounts.localKeys();
        this.keyPicker.items = result.items || [];
      } finally {
        this.keyPicker.loading = false;
      }
    },

    /**
     * 选择已有密钥
     * @param {object} key 密钥项
     */
    pickKey(key) {
      this.form.data.keyPath = key.privateKey;
      this.form.generateKey = false;
      this.keyPicker.visible = false;
    },

    /**
     * 打开删除确认
     * @param {object} account 账号
     */
    askRemove(account) {
      this.removeModal.visible = true;
      this.removeModal.account = account;
      this.removeModal.removeSshBlock = true;
      this.removeModal.keepKeyFiles = true;
      this.removeModal.running = false;
    },

    /**
     * 执行删除
     */
    async doRemove() {
      const account = this.removeModal.account;
      if (!account) return;
      this.removeModal.running = true;
      try {
        const result = await window.gitApi.accounts.remove({
          id: account.id,
          removeSshBlock: this.removeModal.removeSshBlock,
          keepKeyFiles: this.removeModal.keepKeyFiles
        });
        if (!result.ok) {
          this.$root.toast(result.error, 'err');
          return;
        }
        this.removeModal.visible = false;
        this.$root.toast('账号已删除', 'ok');
        this.$emit('refresh');
      } finally {
        this.removeModal.running = false;
      }
    },

    /**
     * 复制当前弹窗里的公钥
     */
    async copyPubText() {
      const copied = await G.copy(this.pub.value);
      this.$root.toast(copied ? '公钥已复制' : '复制失败', copied ? 'ok' : 'err');
    },

    /**
     * 平台显示名
     * @param {string} id 平台 ID
     * @returns {string}
     */
    providerLabel(id) {
      return this.providerLabelMap[id] || '自建';
    },

    /**
     * 测试结果对应的样式类
     * @param {object} account 账号
     * @returns {string}
     */
    testClass(account) {
      const result = this.testResults[account.id];
      if (!result) return '';
      if (result.level === 'ok' || result.ok) return 'ok';
      return 'err';
    },

    shortPath: G.shortPath,
    initial: G.initial
  },

  template: `
    <div>
      <div class="toolbar">
        <div class="toolbar-title">账号</div>
        <span class="toolbar-sub">每个账号 = 一套 SSH 密钥 + 一个 Host 别名 + 一组提交身份</span>
        <div class="spacer"></div>
        <button class="btn ghost sm" @click="testAll" :disabled="!accounts.length">检测全部连通</button>
        <button class="btn ghost sm" @click="applyAll" :disabled="busyAll || !accounts.length">
          {{ busyAll ? '写入中…' : '写入全部 SSH 配置' }}
        </button>
        <button class="btn primary sm" @click="openCreate">+ 新建账号</button>
      </div>

      <div class="banner info" v-if="!accounts.length">
        <span>先建一个账号：生成密钥 → 复制公钥到平台的 SSH Keys → 项目绑定该账号。</span>
      </div>

      <div class="accounts-grid">
        <div class="account-card" v-for="account in accounts" :key="account.id">
          <div class="account-head">
            <div class="account-avatar">{{ initial(account.label) }}</div>
            <div style="flex:1;min-width:0">
              <div class="account-title">
                <span>{{ account.label }}</span>
                <span class="badge">{{ providerLabel(account.provider) }}</span>
                <span class="chip">{{ account.alias }}</span>
              </div>
              <div class="account-sub">{{ account.hostName }}<span v-if="account.port && account.port !== 22">:{{ account.port }}</span></div>
            </div>
          </div>

          <dl class="account-meta">
            <dt>提交身份</dt>
            <dd>{{ account.userName }} &lt;{{ account.userEmail }}&gt;</dd>
            <dt>私钥</dt>
            <dd :title="account.keyPath">{{ shortPath(account.keyPath, 40) }}</dd>
            <dt>算法</dt>
            <dd>{{ account.keyType }} <span class="faint" v-if="account.publicKeyType">· {{ account.publicKeyType }}</span></dd>
            <dt v-if="account.note">备注</dt>
            <dd v-if="account.note">{{ account.note }}</dd>
          </dl>

          <div class="account-status">
            <span class="badge" :class="account.keyExists ? (account.pubExists ? 'ok' : 'warn') : 'err'">
              {{ account.keyExists ? (account.pubExists ? '密钥完整' : '缺公钥') : '无私钥' }}
            </span>
            <span class="badge" :class="account.sshConfigPresent ? (account.sshConfigConsistent ? 'ok' : 'warn') : 'err'">
              {{ account.sshConfigPresent ? (account.sshConfigConsistent ? '配置正常' : '配置不完整') : '未写入配置' }}
            </span>
            <span class="badge" :class="account.domainMappingPresent ? 'ok' : 'faint'"
                  :title="'裸域名 ' + account.hostName + ' 是否也会使用该私钥'">
              {{ account.domainMappingPresent ? '域名兜底已启用' : '裸域名走默认密钥' }}
            </span>
            <span class="badge" :class="testClass(account)" v-if="testResults[account.id]"
                  :title="testResults[account.id].message">
              {{ testing[account.id] ? '测试中…' : (testResults[account.id].ok ? '连通正常' : '连通失败') }}
            </span>
          </div>

          <div class="account-actions">
            <button class="btn xs" @click="copyPub(account)" :disabled="!account.pubExists">复制公钥</button>
            <button class="btn xs" @click="showPub(account)" :disabled="!account.pubExists">查看公钥</button>
            <button class="btn xs" @click="generate(account)">{{ account.keyExists ? '重生成' : '生成密钥' }}</button>
            <button class="btn xs" @click="applyConfig(account)">写入配置</button>
            <button class="btn xs" @click="applyDomain(account)" :title="'让 git@' + account.hostName + ':... 也使用该私钥'">域名兜底</button>
            <button class="btn xs" @click="showBlock(account)">配置块</button>
            <button class="btn xs" @click="testOne(account)" :disabled="testing[account.id]">
              {{ testing[account.id] ? '连接中…' : '测试连通' }}
            </button>
            <button class="btn xs" @click="openEdit(account)">编辑</button>
            <button class="btn xs danger" @click="askRemove(account)">删除</button>
          </div>
        </div>
      </div>

      <ui-empty v-if="!accounts.length" icon="⚿" text="还没有账号，点右上角「新建账号」开始">
      </ui-empty>

      <!-- 账号表单 -->
      <ui-modal :visible="form.visible" :title="form.mode === 'create' ? '新建账号' : '编辑账号'"
                width="700px" @close="form.visible = false">
        <div class="grid-2">
          <div class="field">
            <label>账号名称 <span class="req">*</span></label>
            <input class="input" :class="{ err: form.errors.label }" v-model="form.data.label"
                   placeholder="例如 公司 Gitee" @blur="onLabelBlur">
            <span class="hint err" v-if="form.errors.label">{{ form.errors.label }}</span>
          </div>
          <div class="field">
            <label>平台</label>
            <select class="select" v-model="form.data.provider" @change="onProviderChange(form.data.provider)">
              <option v-for="item in providers" :key="item.id" :value="item.id">{{ item.label }}</option>
            </select>
          </div>
        </div>

        <div class="grid-2">
          <div class="field">
            <label>真实域名 <span class="req">*</span></label>
            <input class="input" :class="{ err: form.errors.hostName }" v-model="form.data.hostName"
                   placeholder="gitee.com">
            <span class="hint err" v-if="form.errors.hostName">{{ form.errors.hostName }}</span>
          </div>
          <div class="field">
            <label>SSH 端口</label>
            <input class="input" type="number" v-model.number="form.data.port" placeholder="22">
            <span class="hint err" v-if="form.errors.port">{{ form.errors.port }}</span>
          </div>
        </div>

        <div class="field">
          <label>SSH 别名 <span class="req">*</span></label>
          <input class="input" :class="{ err: form.errors.alias }" v-model="form.data.alias"
                 placeholder="例如 gitee-work">
          <span class="hint" :class="{ err: form.errors.alias }">
            {{ form.errors.alias || '别名必须与真实域名不同。克隆地址写成 git@别名:owner/repo.git，ssh 才会强制使用这套密钥。' }}
          </span>
        </div>

        <div class="grid-2">
          <div class="field">
            <label>提交用户名 <span class="req">*</span></label>
            <input class="input" v-model="form.data.userName" placeholder="git config user.name">
            <span class="hint">建议与平台账号昵称一致，提交记录才会显示正确作者</span>
          </div>
          <div class="field">
            <label>提交邮箱 <span class="req">*</span></label>
            <input class="input" :class="{ err: form.errors.userEmail }" v-model="form.data.userEmail"
                   placeholder="你@example.com">
            <span class="hint err" v-if="form.errors.userEmail">{{ form.errors.userEmail }}</span>
            <span class="hint" v-else>平台用它匹配提交头像，务必填该账号绑定的邮箱</span>
          </div>
        </div>

        <div class="grid-2">
          <div class="field">
            <label>密钥算法</label>
            <select class="select" v-model="form.data.keyType">
              <option v-for="item in keyTypes" :key="item.id" :value="item.id">{{ item.label }}</option>
            </select>
          </div>
          <div class="field">
            <label>私钥存放路径</label>
            <div class="input-row">
              <input class="input" v-model="form.data.keyPath" placeholder="留空则 ~/.ssh/别名">
              <button class="btn sm ghost" @click="openKeyPicker">已有</button>
            </div>
            <span class="hint">留空时自动使用 ~/.ssh/{{ form.data.alias || '别名' }}</span>
          </div>
        </div>

        <div class="field">
          <label>备注</label>
          <input class="input" v-model="form.data.note" placeholder="选填，例如 用于哪个项目组">
        </div>

        <div class="field" v-if="form.mode === 'create'">
          <label class="checkbox">
            <input type="checkbox" v-model="form.generateKey">
            <span>保存后立即生成密钥（需要 ssh-keygen 可用）</span>
          </label>
          <label class="checkbox" v-if="form.generateKey">
            <input type="checkbox" v-model="form.forceKey">
            <span>若私钥已存在则覆盖（旧文件自动改名为 .bak-时间戳）</span>
          </label>
        </div>

        <div class="hint err" v-if="form.errors._">{{ form.errors._ }}</div>

        <template #footer>
          <span class="err-text" v-if="form.errors._">{{ form.errors._ }}</span>
          <div class="spacer"></div>
          <button class="btn ghost" @click="form.visible = false">取消</button>
          <button class="btn primary" @click="submit" :disabled="form.saving">
            {{ form.saving ? '保存中…' : '保存' }}
          </button>
        </template>
      </ui-modal>

      <!-- 公钥 -->
      <ui-modal :visible="pub.visible" :title="pub.title" width="680px" @close="pub.visible = false">
        <div class="hint mb8">把整行内容粘贴到平台 → 设置 → SSH 公钥 / SSH Keys。</div>
        <div class="code">{{ pub.value }}</div>
        <div class="hint mt8">{{ pub.file }}</div>
        <template #footer>
          <div class="spacer"></div>
          <button class="btn ghost" @click="pub.visible = false">关闭</button>
          <button class="btn primary" @click="copyPubText">复制</button>
        </template>
      </ui-modal>

      <!-- 配置块预览 -->
      <ui-modal :visible="block.visible" :title="block.title" width="680px" @close="block.visible = false">
        <div class="banner" :class="block.inspect && block.inspect.present ? 'info' : 'warn'">
          <span v-if="block.inspect && block.inspect.present">
            {{ block.inspect.consistent ? '该块已在 ~/.ssh/config 中且内容完整' : '已存在但内容不完整，建议重写' }}
          </span>
          <span v-else>尚未写入 ~/.ssh/config</span>
        </div>
        <div class="code">{{ block.block }}</div>
        <div class="hint mt8">写入时只替换该 Host 块，文件其余内容（其它 Host、Match、注释）保持不变，并自动备份为 config.git-tools.bak。</div>
        <template #footer>
          <div class="spacer"></div>
          <button class="btn ghost" @click="block.visible = false">关闭</button>
          <button class="btn primary" @click="block.visible = false">知道了</button>
        </template>
      </ui-modal>

      <!-- 已有密钥选择 -->
      <ui-modal :visible="keyPicker.visible" title="选择 ~/.ssh 下已有的密钥" width="620px"
                @close="keyPicker.visible = false">
        <div class="empty" v-if="keyPicker.loading">读取中…</div>
        <ui-empty v-else-if="!keyPicker.items.length" icon="⚿" text="~/.ssh 下没有找到私钥文件"></ui-empty>
        <div v-else>
          <div v-for="key in keyPicker.items" :key="key.privateKey"
               class="diag-row info" style="cursor:pointer" @click="pickKey(key)">
            <span class="badge mono">{{ key.type }}</span>
            <div class="diag-main">
              <div class="diag-title">{{ key.name }}<span class="diag-target">{{ key.hasPublic ? '含公钥' : '无公钥' }}</span></div>
              <div class="diag-detail mono">{{ key.privateKey }}</div>
            </div>
          </div>
        </div>
        <template #footer>
          <div class="spacer"></div>
          <button class="btn ghost" @click="keyPicker.visible = false">关闭</button>
        </template>
      </ui-modal>

      <!-- 删除确认 -->
      <ui-modal :visible="removeModal.visible" title="删除账号" width="560px" @close="removeModal.visible = false">
        <div class="hint mb12" v-if="removeModal.account">
          即将删除账号「{{ removeModal.account.label }}」。仅从本工具配置中移除，不会影响你已有的项目仓库。
        </div>
        <label class="checkbox mb8" style="display:flex">
          <input type="checkbox" v-model="removeModal.removeSshBlock">
          <span>同时移除 ~/.ssh/config 中的该 Host 块（会先备份 config.git-tools.bak）</span>
        </label>
        <label class="checkbox" style="display:flex">
          <input type="checkbox" v-model="removeModal.keepKeyFiles">
          <span>保留密钥文件（推荐；取消勾选将删除私钥与公钥文件）</span>
        </label>
        <div class="banner warn mt12" v-if="!removeModal.keepKeyFiles">
          <span>取消勾选会永久删除私钥文件，无法恢复。</span>
        </div>
        <template #footer>
          <div class="spacer"></div>
          <button class="btn ghost" @click="removeModal.visible = false">取消</button>
          <button class="btn danger" @click="doRemove" :disabled="removeModal.running">
            {{ removeModal.running ? '删除中…' : '确认删除' }}
          </button>
        </template>
      </ui-modal>
    </div>
  `
});
