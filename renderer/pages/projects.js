'use strict';

/**
 * 项目页
 * ------------------------------------------------------------
 * 职责：登记已有仓库、扫描批量导入、克隆新仓库、给仓库绑定账号
 * （绑定会同时改写 remote 为别名地址 + 写入仓库级 user.name/email）。
 * @author yittiger
 */

Vue.component('projects-page', {
  props: {
    projects: { type: Array, default: () => [] },
    accounts: { type: Array, default: () => [] }
  },

  data() {
    return {
      keyword: '',
      addModal: { visible: false, path: '', name: '', accountId: '', error: '', saving: false },
      bindModal: {
        visible: false,
        project: null,
        accountId: '',
        preview: null,
        loading: false,
        applying: false,
        repoPath: '',
        rewriteRemote: true,
        applyIdentity: true,
        error: ''
      },
      scanModal: {
        visible: false,
        rootDir: '',
        depth: 3,
        items: [],
        scanning: false,
        importing: false,
        error: ''
      },
      cloneModal: {
        visible: false,
        url: '',
        accountId: '',
        targetDir: '',
        folderName: '',
        running: false,
        output: '',
        error: ''
      },
      detailModal: { visible: false, loading: false, runtime: null, error: '' },
      removeModal: { visible: false, project: null, running: false }
    };
  },

  computed: {
    filtered() {
      const text = this.keyword.trim().toLowerCase();
      if (!text) return this.projects;
      return this.projects.filter((project) =>
        (project.name + ' ' + project.path + ' ' + (project.accountLabel || '')).toLowerCase().indexOf(text) >= 0
      );
    },
    accountOptions() {
      return this.accounts.map((account) => ({ id: account.id, label: account.label, alias: account.alias }));
    }
  },

  methods: {
    shortPath: G.shortPath,

    /**
     * 打开添加项目弹窗
     */
    openAdd() {
      this.addModal = { visible: true, path: '', name: '', accountId: '', error: '', saving: false };
    },

    /**
     * 选择仓库目录
     */
    async pickAddFolder() {
      const result = await window.gitApi.system.selectFolder({ title: '选择 Git 仓库目录' });
      if (result.ok) {
        this.addModal.path = result.path;
        if (!this.addModal.name) {
          const parts = result.path.replace(/[\\/]+$/, '').split(/[\\/]/);
          this.addModal.name = parts[parts.length - 1] || '';
        }
      }
    },

    /**
     * 提交添加
     */
    async submitAdd() {
      this.addModal.error = '';
      if (!this.addModal.path) {
        this.addModal.error = '请选择项目目录';
        return;
      }
      this.addModal.saving = true;
      try {
        const result = await window.gitApi.projects.add({
          path: this.addModal.path,
          name: this.addModal.name,
          accountId: this.addModal.accountId
        });
        if (!result.ok) {
          this.addModal.error = result.error;
          return;
        }
        this.addModal.visible = false;
        this.$root.toast('已添加项目：' + result.project.name, 'ok');
        this.$emit('refresh');
      } catch (err) {
        this.addModal.error = err.message;
      } finally {
        this.addModal.saving = false;
      }
    },

    /**
     * 打开扫描弹窗
     */
    openScan() {
      this.scanModal.visible = true;
      this.scanModal.items = [];
      this.scanModal.error = '';
    },

    /**
     * 选择扫描根目录
     */
    async pickScanRoot() {
      const result = await window.gitApi.system.selectFolder({ title: '选择要扫描的父目录' });
      if (result.ok) this.scanModal.rootDir = result.path;
    },

    /**
     * 执行扫描
     */
    async runScan() {
      this.scanModal.error = '';
      if (!this.scanModal.rootDir) {
        this.scanModal.error = '请先选择扫描目录';
        return;
      }
      this.scanModal.scanning = true;
      try {
        const result = await window.gitApi.projects.scan({
          rootDir: this.scanModal.rootDir,
          depth: this.scanModal.depth
        });
        if (!result.ok) {
          this.scanModal.error = result.error;
          return;
        }
        this.scanModal.items = result.items.map((entry) => ({
          path: entry.path,
          name: entry.name,
          alreadyAdded: entry.alreadyAdded,
          checked: !entry.alreadyAdded,
          accountId: ''
        }));
        this.$root.toast('扫描完成，找到 ' + result.items.length + ' 个仓库', 'ok');
      } catch (err) {
        this.scanModal.error = err.message;
      } finally {
        this.scanModal.scanning = false;
      }
    },

    /**
     * 批量导入选中的仓库
     */
    async importScan() {
      const selected = this.scanModal.items.filter((entry) => entry.checked && !entry.alreadyAdded);
      if (!selected.length) {
        this.$root.toast('没有选中任何仓库', 'err');
        return;
      }
      this.scanModal.importing = true;
      try {
        const result = await window.gitApi.projects.addBatch({
          items: selected.map((entry) => ({ path: entry.path, accountId: entry.accountId }))
        });
        const okCount = result.results.filter((entry) => entry.ok).length;

        // 选了账号的，顺手完成绑定（改写 remote + 写本地身份）
        for (let i = 0; i < selected.length; i += 1) {
          const added = result.results[i];
          if (added && added.ok && added.project && selected[i].accountId) {
            await window.gitApi.projects.bind({
              id: added.project.id,
              accountId: selected[i].accountId,
              options: {}
            });
          }
        }

        this.scanModal.visible = false;
        this.$root.toast('已导入 ' + okCount + ' 个仓库', 'ok');
        this.$emit('refresh');
      } catch (err) {
        this.$root.toast(err.message, 'err');
      } finally {
        this.scanModal.importing = false;
      }
    },

    /**
     * 打开克隆弹窗
     */
    openClone() {
      this.cloneModal = {
        visible: true,
        url: '',
        accountId: '',
        targetDir: '',
        folderName: '',
        running: false,
        output: '',
        error: ''
      };
    },

    /**
     * 选择克隆目标目录
     */
    async pickCloneTarget() {
      const result = await window.gitApi.system.selectFolder({ title: '选择克隆目标父目录' });
      if (result.ok) this.cloneModal.targetDir = result.path;
    },

    /**
     * 执行克隆
     */
    async runClone() {
      this.cloneModal.error = '';
      this.cloneModal.output = '';
      if (!this.cloneModal.url) {
        this.cloneModal.error = '请填写仓库地址';
        return;
      }
      if (!this.cloneModal.targetDir) {
        this.cloneModal.error = '请选择克隆目标目录';
        return;
      }
      this.cloneModal.running = true;
      this.cloneModal.output = '克隆中，请稍候…';
      try {
        const result = await window.gitApi.projects.clone({
          url: this.cloneModal.url,
          accountId: this.cloneModal.accountId,
          targetDir: this.cloneModal.targetDir,
          folderName: this.cloneModal.folderName
        });
        if (!result.ok) {
          this.cloneModal.error = result.error;
          this.cloneModal.output = (result.url && result.url !== this.cloneModal.url ? '实际请求地址：' + result.url + '\n' : '') + (result.error || '克隆失败');
          return;
        }
        const resolveText = result.accountAlias
          ? '使用账号：' + result.accountAlias + (result.autoMatchedBy ? '（自动匹配）' : '') + '\n'
          : '使用账号：未匹配（按原地址克隆）\n';
        this.cloneModal.output = resolveText + '实际使用地址：' + result.url + '\n' + (result.output || '') + '\n完成：' + result.path;
        this.$root.toast('克隆完成：' + result.path, 'ok');
        this.$emit('refresh');
      } catch (err) {
        this.cloneModal.error = err.message;
      } finally {
        this.cloneModal.running = false;
      }
    },

    /**
     * 打开绑定弹窗
     * @param {object} project 项目
     */
    openBind(project) {
      this.bindModal.visible = true;
      this.bindModal.project = project;
      this.bindModal.accountId = project.accountId || (this.accounts[0] ? this.accounts[0].id : '');
      this.bindModal.preview = null;
      this.bindModal.error = '';
      this.bindModal.repoPath = '';
      this.bindModal.rewriteRemote = true;
      this.bindModal.applyIdentity = true;
      if (this.bindModal.accountId) this.loadPreview();
    },

    /**
     * 读取绑定预览
     */
    async loadPreview() {
      if (!this.bindModal.project || !this.bindModal.accountId) return;
      this.bindModal.loading = true;
      this.bindModal.preview = null;
      try {
        const result = await window.gitApi.projects.previewBind({
          id: this.bindModal.project.id,
          accountId: this.bindModal.accountId
        });
        if (result.ok) {
          this.bindModal.preview = result;
        } else {
          this.bindModal.error = result.error;
        }
      } catch (err) {
        this.bindModal.error = err.message;
      } finally {
        this.bindModal.loading = false;
      }
    },

    /**
     * 执行绑定
     */
    async applyBind() {
      if (!this.bindModal.project || !this.bindModal.accountId) return;
      this.bindModal.applying = true;
      this.bindModal.error = '';
      try {
        const options = {
          rewriteRemote: this.bindModal.rewriteRemote,
          applyIdentity: this.bindModal.applyIdentity
        };
        const manualPath = this.bindModal.repoPath.trim();
        if (manualPath) {
          // 允许填 owner/repo.git，也允许粘贴完整远程地址
          options.url = manualPath.indexOf('://') >= 0 || manualPath.indexOf('@') >= 0
            ? manualPath
            : 'git@placeholder:' + manualPath.replace(/^[/\\]+/, '');
        }
        const result = await window.gitApi.projects.bind({
          id: this.bindModal.project.id,
          accountId: this.bindModal.accountId,
          options: options
        });
        if (!result.ok) {
          const failed = (result.steps || [])
            .filter((step) => !step.ok)
            .map((step) => step.name + '：' + step.message);
          this.bindModal.error = failed.join('；') || result.error || '绑定失败';
          return;
        }
        this.bindModal.visible = false;
        this.$root.toast('已绑定账号并写入本地提交身份', 'ok');
        this.$emit('refresh');
      } catch (err) {
        this.bindModal.error = err.message;
      } finally {
        this.bindModal.applying = false;
      }
    },

    /**
     * 打开项目详情
     * @param {object} project 项目
     */
    async openDetail(project) {
      this.detailModal.visible = true;
      this.detailModal.loading = true;
      this.detailModal.runtime = null;
      this.detailModal.error = '';
      try {
        const result = await window.gitApi.projects.runtime(project.id);
        if (result.ok) {
          this.detailModal.runtime = result;
        } else {
          this.detailModal.error = result.error;
        }
      } catch (err) {
        this.detailModal.error = err.message;
      } finally {
        this.detailModal.loading = false;
      }
    },

    /**
     * 打开项目文件夹
     * @param {object} project 项目
     */
    async openFolder(project) {
      const result = await window.gitApi.system.openPath(project.path);
      if (!result.ok) this.$root.toast(result.error, 'err');
    },

    /**
     * 询问移除
     * @param {object} project 项目
     */
    askRemove(project) {
      this.removeModal.visible = true;
      this.removeModal.project = project;
      this.removeModal.running = false;
    },

    /**
     * 从列表移除项目
     */
    async doRemove() {
      if (!this.removeModal.project) return;
      this.removeModal.running = true;
      try {
        const result = await window.gitApi.projects.remove(this.removeModal.project.id);
        if (!result.ok) {
          this.$root.toast(result.error, 'err');
          return;
        }
        this.removeModal.visible = false;
        this.$root.toast('已从列表移除（磁盘文件未改动）', 'ok');
        this.$emit('refresh');
      } finally {
        this.removeModal.running = false;
      }
    },

    /**
     * 跳转到 Git 面板
     * @param {object} project 项目
     */
    gotoGit(project) {
      this.$root.openGit(project.id);
    }
  },

  template: `
    <div>
      <div class="toolbar">
        <div class="toolbar-title">项目</div>
        <span class="toolbar-sub">已登记 {{ projects.length }} 个仓库</span>
        <div class="spacer"></div>
        <input class="input" style="width:190px" v-model="keyword" placeholder="搜索名称 / 路径 / 账号">
        <button class="btn ghost sm" @click="openScan">扫描目录导入</button>
        <button class="btn ghost sm" @click="openClone">克隆仓库</button>
        <button class="btn primary sm" @click="openAdd">+ 添加项目</button>
      </div>

      <div class="banner warn" v-if="!accounts.length">
        <span>还没有账号。项目必须先有账号，才能把 remote 改写成别名地址。</span>
        <div class="spacer"></div>
        <button class="btn sm" @click="$root.switchTab('accounts')">去建账号</button>
      </div>

      <div class="card" v-if="projects.length">
        <table class="table">
          <thead>
            <tr>
              <th style="width:160px">项目</th>
              <th>路径</th>
              <th style="width:150px">绑定账号</th>
              <th style="width:110px">状态</th>
              <th style="width:320px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="project in filtered" :key="project.id">
              <td>{{ project.name }}</td>
              <td class="mono cell-ellipsis" :title="project.path">{{ shortPath(project.path, 48) }}</td>
              <td>
                <span class="badge ok" v-if="project.accountLabel">{{ project.accountLabel }}</span>
                <span class="badge warn" v-else>未绑定</span>
                <div class="small faint mono-text" v-if="project.accountAlias">{{ project.accountAlias }}</div>
              </td>
              <td>
                <span class="badge err" v-if="!project.exists">目录不存在</span>
                <span class="badge err" v-else-if="!project.isRepo">非 Git 仓库</span>
                <span class="badge ok" v-else>正常</span>
              </td>
              <td>
                <button class="btn xs" @click="openBind(project)">绑定账号</button>
                <button class="btn xs" @click="openDetail(project)">详情</button>
                <button class="btn xs" @click="gotoGit(project)">Git 面板</button>
                <button class="btn xs" @click="openFolder(project)">打开目录</button>
                <button class="btn xs danger" @click="askRemove(project)">移除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <ui-empty v-if="!projects.length" icon="▤"
        text="还没有项目。可以「添加项目」选择已有仓库，或「扫描目录导入」批量发现。">
      </ui-empty>

      <!-- 添加项目 -->
      <ui-modal :visible="addModal.visible" title="添加项目" width="600px" @close="addModal.visible = false">
        <div class="field">
          <label>仓库目录 <span class="req">*</span></label>
          <div class="input-row">
            <input class="input" v-model="addModal.path" placeholder="D:\\code\\companyCode\\demo">
            <button class="btn sm ghost" @click="pickAddFolder">选择</button>
          </div>
          <span class="hint">必须是已存在的 Git 仓库（目录内有 .git）</span>
        </div>
        <div class="grid-2">
          <div class="field">
            <label>显示名称</label>
            <input class="input" v-model="addModal.name" placeholder="留空取目录名">
          </div>
          <div class="field">
            <label>绑定账号</label>
            <select class="select" v-model="addModal.accountId">
              <option value="">暂不绑定</option>
              <option v-for="item in accountOptions" :key="item.id" :value="item.id">{{ item.label }} · {{ item.alias }}</option>
            </select>
          </div>
        </div>
        <div class="hint err" v-if="addModal.error">{{ addModal.error }}</div>
        <template #footer>
          <div class="spacer"></div>
          <button class="btn ghost" @click="addModal.visible = false">取消</button>
          <button class="btn primary" @click="submitAdd" :disabled="addModal.saving">
            {{ addModal.saving ? '添加中…' : '添加' }}
          </button>
        </template>
      </ui-modal>

      <!-- 绑定账号 -->
      <ui-modal :visible="bindModal.visible" title="绑定账号" width="700px" @close="bindModal.visible = false">
        <div class="field" v-if="bindModal.project">
          <label>项目</label>
          <div class="code" style="padding:7px 11px">{{ bindModal.project.name }} · {{ bindModal.project.path }}</div>
        </div>

        <div class="field">
          <label>选择账号 <span class="req">*</span></label>
          <select class="select" v-model="bindModal.accountId" @change="loadPreview">
            <option value="">请选择</option>
            <option v-for="item in accountOptions" :key="item.id" :value="item.id">{{ item.label }} · {{ item.alias }}</option>
          </select>
        </div>

        <div v-if="bindModal.loading" class="hint">读取远程信息…</div>

        <div v-if="bindModal.preview">
          <div class="card mb12">
            <div class="card-head">远程地址变更</div>
            <div class="card-body">
              <div v-if="bindModal.preview.currentUrl">
                <div class="diff-line old"><span class="mark">−</span><span>{{ bindModal.preview.currentUrl }}</span></div>
                <div class="diff-line new"><span class="mark">+</span><span>{{ bindModal.preview.nextUrl }}</span></div>
              </div>
              <div class="hint err" v-else>
                没有读到 {{ bindModal.preview.remoteName }} 远程地址，请在下方填写仓库路径（owner/repo.git）。
              </div>
            </div>
          </div>

          <div class="card mb12">
            <div class="card-head">提交身份（仓库级，优先级高于全局）</div>
            <div class="card-body">
              <div class="diff-line old">
                <span class="mark">−</span>
                <span>{{ bindModal.preview.currentIdentity.name || '(未设置)' }} &lt;{{ bindModal.preview.currentIdentity.email || '(未设置)' }}&gt;</span>
              </div>
              <div class="diff-line new">
                <span class="mark">+</span>
                <span>{{ bindModal.preview.nextIdentity.name }} &lt;{{ bindModal.preview.nextIdentity.email }}&gt;</span>
              </div>
            </div>
          </div>

          <div class="field">
            <label>仓库路径（远程缺失或需要纠正时填写）</label>
            <input class="input" v-model="bindModal.repoPath" placeholder="owner/repo.git 或完整地址">
          </div>

          <label class="checkbox mb8" style="display:flex">
            <input type="checkbox" v-model="bindModal.rewriteRemote">
            <span>改写远程地址为别名地址（git@别名:owner/repo.git）</span>
          </label>
          <label class="checkbox" style="display:flex">
            <input type="checkbox" v-model="bindModal.applyIdentity">
            <span>写入仓库级 user.name / user.email（不影响其它仓库）</span>
          </label>
        </div>

        <div class="hint err mt8" v-if="bindModal.error">{{ bindModal.error }}</div>

        <template #footer>
          <div class="spacer"></div>
          <button class="btn ghost" @click="bindModal.visible = false">取消</button>
          <button class="btn primary" @click="applyBind" :disabled="bindModal.applying || !bindModal.accountId">
            {{ bindModal.applying ? '处理中…' : '应用' }}
          </button>
        </template>
      </ui-modal>

      <!-- 扫描导入 -->
      <ui-modal :visible="scanModal.visible" title="扫描目录导入仓库" width="760px"
                @close="scanModal.visible = false">
        <div class="field">
          <label>父目录 <span class="req">*</span></label>
          <div class="input-row">
            <input class="input" v-model="scanModal.rootDir" placeholder="例如 D:\\code">
            <button class="btn sm ghost" @click="pickScanRoot">选择</button>
          </div>
        </div>
        <div class="field" style="max-width:180px">
          <label>向下扫描层数</label>
          <input class="input" type="number" min="1" max="6" v-model.number="scanModal.depth">
        </div>
        <div class="mb12">
          <button class="btn sm" @click="runScan" :disabled="scanModal.scanning">
            {{ scanModal.scanning ? '扫描中…' : '开始扫描' }}
          </button>
        </div>
        <div class="hint err" v-if="scanModal.error">{{ scanModal.error }}</div>

        <div style="max-height:300px;overflow-y:auto" v-if="scanModal.items.length">
          <table class="table">
            <thead>
              <tr>
                <th style="width:40px"></th>
                <th>仓库</th>
                <th style="width:190px">绑定账号</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in scanModal.items" :key="item.path">
                <td>
                  <input type="checkbox" v-model="item.checked" :disabled="item.alreadyAdded">
                </td>
                <td>
                  <div>{{ item.name }}</div>
                  <div class="small faint mono-text">{{ shortPath(item.path, 56) }}</div>
                </td>
                <td>
                  <select class="select" v-model="item.accountId" :disabled="item.alreadyAdded || !item.checked">
                    <option value="">暂不绑定</option>
                    <option v-for="acc in accountOptions" :key="acc.id" :value="acc.id">{{ acc.label }}</option>
                  </select>
                  <div class="small faint" v-if="item.alreadyAdded">已在列表中</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <template #footer>
          <div class="spacer"></div>
          <button class="btn ghost" @click="scanModal.visible = false">取消</button>
          <button class="btn primary" @click="importScan" :disabled="scanModal.importing || !scanModal.items.length">
            {{ scanModal.importing ? '导入中…' : '导入选中' }}
          </button>
        </template>
      </ui-modal>

      <!-- 克隆仓库 -->
      <ui-modal :visible="cloneModal.visible" title="克隆仓库" width="680px" @close="cloneModal.visible = false">
        <div class="field">
          <label>仓库地址 <span class="req">*</span></label>
          <input class="input" v-model="cloneModal.url" placeholder="git@gitee.com:owner/repo.git 或 https://...">
          <span class="hint">选择账号后会自动改写为 git@别名:owner/repo.git，无需手动替换域名。</span>
        </div>
        <div class="field">
          <label>使用账号</label>
          <select class="select" v-model="cloneModal.accountId">
            <option value="">不指定（按地址自动匹配域名下的账号）</option>
            <option v-for="item in accountOptions" :key="item.id" :value="item.id">{{ item.label }} · {{ item.alias }}</option>
          </select>
          <span class="hint">不指定时会按地址里的域名自动找账号；同一域名有多个账号时必须手动选择，否则会退回默认 ~/.ssh/id_rsa 导致 Permission denied (publickey)。</span>
        </div>
        <div class="grid-2">
          <div class="field">
            <label>目标目录 <span class="req">*</span></label>
            <div class="input-row">
              <input class="input" v-model="cloneModal.targetDir" placeholder="D:\\code">
              <button class="btn sm ghost" @click="pickCloneTarget">选择</button>
            </div>
          </div>
          <div class="field">
            <label>目录名（可选）</label>
            <input class="input" v-model="cloneModal.folderName" placeholder="留空取仓库名">
          </div>
        </div>
        <div class="code" v-if="cloneModal.output" style="max-height:180px;overflow-y:auto">{{ cloneModal.output }}</div>
        <div class="hint err mt8" v-if="cloneModal.error">{{ cloneModal.error }}</div>
        <template #footer>
          <div class="spacer"></div>
          <button class="btn ghost" @click="cloneModal.visible = false">关闭</button>
          <button class="btn primary" @click="runClone" :disabled="cloneModal.running">
            {{ cloneModal.running ? '克隆中…' : '开始克隆' }}
          </button>
        </template>
      </ui-modal>

      <!-- 项目详情 -->
      <ui-modal :visible="detailModal.visible" title="项目详情" width="720px" @close="detailModal.visible = false">
        <div v-if="detailModal.loading" class="hint">读取中…</div>
        <div v-else-if="detailModal.error" class="banner err">{{ detailModal.error }}</div>
        <div v-else-if="detailModal.runtime">
          <div class="kv-list mb12">
            <div class="kv-row"><span class="k">分支</span><span class="v">{{ detailModal.runtime.branch }}</span></div>
            <div class="kv-row"><span class="k">上游</span><span class="v">{{ detailModal.runtime.upstream || '未设置' }}</span></div>
            <div class="kv-row"><span class="k">领先/落后</span><span class="v">{{ detailModal.runtime.ahead }} / {{ detailModal.runtime.behind }}</span></div>
            <div class="kv-row"><span class="k">本地身份</span><span class="v">{{ detailModal.runtime.identity.name || '(未设置)' }} &lt;{{ detailModal.runtime.identity.email || '(未设置)' }}&gt;</span></div>
            <div class="kv-row"><span class="k">绑定账号</span><span class="v">{{ detailModal.runtime.account ? detailModal.runtime.account.label + ' · ' + detailModal.runtime.account.alias : '未绑定' }}</span></div>
          </div>

          <div class="card mb12">
            <div class="card-head">远程地址</div>
            <div class="card-body">
              <div class="kv-row" v-for="remote in detailModal.runtime.remotes" :key="remote.name">
                <span class="k">{{ remote.name }}</span>
                <span class="v">{{ remote.url }}</span>
              </div>
              <div class="hint" v-if="!detailModal.runtime.remotes.length">没有配置远程地址</div>
            </div>
          </div>

          <div class="card mb12" v-if="detailModal.runtime.lastCommit">
            <div class="card-head">最近提交</div>
            <div class="card-body">
              <div class="kv-row"><span class="k">提交</span><span class="v">{{ detailModal.runtime.lastCommit.hash }}</span></div>
              <div class="kv-row"><span class="k">作者</span><span class="v">{{ detailModal.runtime.lastCommit.author }} &lt;{{ detailModal.runtime.lastCommit.email }}&gt;</span></div>
              <div class="kv-row"><span class="k">时间</span><span class="v">{{ detailModal.runtime.lastCommit.date }}</span></div>
              <div class="kv-row"><span class="k">说明</span><span class="v">{{ detailModal.runtime.lastCommit.subject }}</span></div>
            </div>
          </div>

          <div class="card">
            <div class="card-head">工作区变更（{{ detailModal.runtime.dirtyCount }}）</div>
            <div class="card-body">
              <div class="file-list">
                <div class="file-item" v-for="file in detailModal.runtime.changedFiles" :key="file.file">
                  <span class="st">{{ file.status }}</span><span>{{ file.file }}</span>
                </div>
              </div>
              <div class="hint" v-if="!detailModal.runtime.changedFiles.length">工作区干净</div>
            </div>
          </div>
        </div>
        <template #footer>
          <div class="spacer"></div>
          <button class="btn ghost" @click="detailModal.visible = false">关闭</button>
        </template>
      </ui-modal>

      <!-- 移除确认 -->
      <ui-modal :visible="removeModal.visible" title="从列表移除项目" width="520px"
                @close="removeModal.visible = false">
        <div class="hint" v-if="removeModal.project">
          仅从本工具的项目列表移除「{{ removeModal.project.name }}」，不会删除磁盘上的仓库文件。
        </div>
        <template #footer>
          <div class="spacer"></div>
          <button class="btn ghost" @click="removeModal.visible = false">取消</button>
          <button class="btn danger" @click="doRemove" :disabled="removeModal.running">确认移除</button>
        </template>
      </ui-modal>
    </div>
  `
});
