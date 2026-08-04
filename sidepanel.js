// Domain Traffic Inspector - Side Panel Logic
// 共有定数・関数は lib/domain-utils.js で定義（HTMLで先に読み込み）
const MAX_IMPORT_RULES = 4999;

class DomainTrafficInspector {
  constructor() {
    this.currentTabId = null;
    this.currentWindowId = null;
    this.domainData = {
      domain_counts: {},
      main_domain: null,
      blocked_domains: [],
      mode: 'normal',
      allowed_domains: [],
      blocking_enabled: true,
      domain_rules: {},
      site_policy: {
        site_domain: null,
        enabled: false,
        rules: {},
        temporary_allows: {},
        precise_scope: false
      }
    };
    this.domainRules = {};
    this.policyScope = 'global';
    this.expandedTags = new Set();
    this.sortBy = 'count';
    this.searchQueries = { traffic: '', rules: '' };
    this.activeTab = 'traffic';
    this.trafficFilter = 'all';
    this.editingRuleDomain = null;
    this.showingAddForm = false;
    this.selectedRules = new Set();

    this.ready = this.init();
  }

  // HTMLエスケープ
  escapeHtml(str) {
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  async request(message) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (!response) throw new Error('バックグラウンドから応答がありません');
      if (response.success === false) throw new Error(response.error || '操作に失敗しました');
      return response;
    } catch (error) {
      this.showToast(error.message || '操作に失敗しました', 'error');
      error.reportedToUser = true;
      throw error;
    }
  }

  runAction(action) {
    Promise.resolve()
      .then(action)
      .catch(error => {
        console.error('Action failed:', error);
        this.render();
      });
  }

  showToast(message, type = 'success') {
    const region = document.getElementById('toastRegion');
    if (!region) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.textContent = message;
    region.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 180);
    }, 3200);
  }

  confirmAction({ title, message, confirmLabel = '実行', danger = true }) {
    const dialog = document.getElementById('confirmDialog');
    const titleElement = document.getElementById('confirmDialogTitle');
    const messageElement = document.getElementById('confirmDialogMessage');
    const acceptButton = document.getElementById('confirmDialogAccept');

    if (dialog.open) dialog.close('cancel');
    titleElement.textContent = title;
    messageElement.textContent = message;
    acceptButton.textContent = confirmLabel;
    acceptButton.classList.toggle('danger', danger);
    dialog.returnValue = 'cancel';

    return new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
      dialog.showModal();
    });
  }

  // 全ルールから登録済みタグの一覧を取得
  getAllExistingTags() {
    const tagSet = new Set();
    Object.values(this.domainRules).forEach(rule => {
      if (rule.tags) rule.tags.forEach(t => tagSet.add(t));
    });
    return Array.from(tagSet).sort((a, b) => a.localeCompare(b));
  }

  // タグ入力にサジェストドロップダウンを設定する共通メソッド
  setupTagSuggest(tagInput, currentTags, onAddTag) {
    const dropdown = document.createElement('div');
    dropdown.className = 'tag-suggest-dropdown';
    tagInput.parentElement.style.position = 'relative';
    tagInput.parentElement.appendChild(dropdown);

    const updateSuggestions = () => {
      const query = tagInput.value.trim().toLowerCase();
      const existing = this.getAllExistingTags()
        .filter(t => !currentTags.includes(t))
        .filter(t => !query || t.toLowerCase().includes(query));

      if (existing.length === 0) {
        dropdown.style.display = 'none';
        return;
      }

      dropdown.innerHTML = '';
      existing.forEach(tag => {
        const item = document.createElement('div');
        item.className = 'tag-suggest-item';
        item.textContent = tag;
        item.addEventListener('mousedown', (e) => {
          e.preventDefault(); // inputのblurを防止
          onAddTag(tag);
          tagInput.value = '';
          dropdown.style.display = 'none';
        });
        dropdown.appendChild(item);
      });
      dropdown.style.display = 'block';
    };

    tagInput.addEventListener('focus', updateSuggestions);
    tagInput.addEventListener('input', updateSuggestions);
    tagInput.addEventListener('blur', () => {
      // mousedownのpreventDefaultで選択を処理後に閉じる
      setTimeout(() => { dropdown.style.display = 'none'; }, 150);
    });
  }

  // ドメイン判定（lib/domain-utils.js の共有関数へ委譲）
  isLikelyAd(domain) { return isLikelyAd(domain); }
  isLikelySafe(domain) { return isLikelySafe(domain); }
  isThirdParty(domain) { return isThirdParty(domain, this.domainData.main_domain); }

  getGlobalPolicyRule(domain) {
    const ruleDomain = findMostSpecificDomainRule(domain, Object.keys(this.domainRules));
    if (!ruleDomain) return null;
    return {
      domain: ruleDomain,
      action: this.domainRules[ruleDomain].action,
      inherited: ruleDomain !== domain,
      source: 'global'
    };
  }

  getTemporarySiteRule(domain) {
    const policy = this.domainData.site_policy;
    if (!policy?.enabled || !policy.site_domain) return null;

    const now = Date.now();
    const temporaryAllows = policy.temporary_allows || {};
    const activeTemporaryDomains = Object.keys(temporaryAllows)
      .filter(ruleDomain => Number(temporaryAllows[ruleDomain]) > now);
    const temporaryDomain = findMostSpecificDomainRule(domain, activeTemporaryDomains);
    if (temporaryDomain) {
      return {
        domain: temporaryDomain,
        action: 'allow',
        inherited: temporaryDomain !== domain,
        source: 'temporary',
        expiresAt: Number(temporaryAllows[temporaryDomain])
      };
    }
    return null;
  }

  getSitePolicyRule(domain, { includeDefault = true } = {}) {
    const policy = this.domainData.site_policy;
    if (!policy?.enabled || !policy.site_domain) return null;

    const temporaryRule = this.getTemporarySiteRule(domain);
    if (temporaryRule) return temporaryRule;

    const rules = policy.rules || {};
    const ruleDomain = findMostSpecificDomainRule(domain, Object.keys(rules));
    if (ruleDomain) {
      return {
        domain: ruleDomain,
        action: rules[ruleDomain].action,
        inherited: ruleDomain !== domain,
        source: 'site'
      };
    }

    if (!includeDefault) return null;
    return {
      domain: policy.site_domain,
      action: 'block',
      inherited: domain !== policy.site_domain,
      source: 'site-default',
      defaultRule: true
    };
  }

  getEffectivePolicyRule(domain) {
    return this.getSitePolicyRule(domain) || this.getGlobalPolicyRule(domain);
  }

  getScopedControlRule(domain) {
    if (this.policyScope !== 'site') return this.getGlobalPolicyRule(domain);
    const rules = this.domainData.site_policy?.rules || {};
    const ruleDomain = findMostSpecificDomainRule(domain, Object.keys(rules));
    if (!ruleDomain) return null;
    return {
      domain: ruleDomain,
      action: rules[ruleDomain].action,
      inherited: ruleDomain !== domain,
      source: 'site'
    };
  }

  isFirstParty(domain) {
    return Boolean(this.domainData.main_domain) && !this.isThirdParty(domain);
  }

  async init() {
    await this.getCurrentTab();
    this.bindEvents();
    this.startListening();
    await this.loadData();
  }

  async getCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      this.currentTabId = tab.id;
      this.currentWindowId = tab.windowId;
    }
  }

  bindEvents() {
    // 検索入力
    const searchInput = document.getElementById('searchInput');
    searchInput.addEventListener('input', (e) => {
      this.searchQueries[this.activeTab] = e.target.value.toLowerCase();
      this.render();
    });

    // クリアボタン
    const clearBtn = document.getElementById('clearBtn');
    clearBtn.addEventListener('click', () => this.runAction(() => this.clearCounts()));

    // ソートセレクト
    const sortSelect = document.getElementById('sortSelect');
    sortSelect.addEventListener('change', (e) => {
      this.sortBy = e.target.value;
      this.render();
    });

    // フィルタセレクト
    const filterSelect = document.getElementById('filterSelect');
    filterSelect.addEventListener('change', (e) => {
      this.trafficFilter = e.target.value;
      this.render();
    });

    // タブ切り替え
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        tabBtns.forEach(b => b.setAttribute('aria-selected', 'false'));
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        this.activeTab = btn.dataset.tab;
        // タブ切替時に検索欄を復元
        searchInput.value = this.searchQueries[this.activeTab] || '';
        this.updateTabPanels();
        this.render();
      });
      btn.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const buttons = Array.from(tabBtns);
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const nextIndex = (buttons.indexOf(btn) + direction + buttons.length) % buttons.length;
        buttons[nextIndex].focus();
        buttons[nextIndex].click();
      });
    });

    // タブ切り替え監視
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
      if (this.currentWindowId !== null && activeInfo.windowId !== this.currentWindowId) return;
      this.currentTabId = activeInfo.tabId;
      await this.loadData();
    });

    // 一括ブロックボタン
    const bulkBlockBtn = document.getElementById('bulkBlockBtn');
    bulkBlockBtn.addEventListener('click', () => this.runAction(() => this.bulkPolicyAction()));

    const allowCurrentSiteBtn = document.getElementById('allowCurrentSiteBtn');
    allowCurrentSiteBtn.addEventListener('click', () => this.runAction(() => this.handlePolicyBuilderAction()));

    document.querySelectorAll('[data-policy-scope]').forEach(button => {
      button.addEventListener('click', () => this.setPolicyScope(button.dataset.policyScope));
    });

    // モードトグル
    const modeToggle = document.getElementById('modeToggle');
    modeToggle.addEventListener('change', () => this.runAction(() => this.toggleMode()));

    // ブロック機能ON/OFFスイッチ
    const blockingSwitch = document.getElementById('blockingSwitch');
    blockingSwitch.addEventListener('change', () => this.runAction(() => this.toggleBlocking()));

    // ルールタブ: 追加ボタン
    const addRuleBtn = document.getElementById('addRuleBtn');
    addRuleBtn.addEventListener('click', () => this.showAddRuleForm());

    // ルールタブ: 全削除ボタン
    const deleteAllRulesBtn = document.getElementById('deleteAllRulesBtn');
    deleteAllRulesBtn.addEventListener('click', () => this.runAction(() => this.deleteAllRules()));

    // ルールタブ: エクスポート/インポート
    document.getElementById('exportRulesBtn').addEventListener('click', () => this.exportRules(false));
    document.getElementById('importRulesBtn').addEventListener('click', () => this.importRules());
    document.getElementById('importFileInput').addEventListener('change', (e) => {
      if (e.target.files[0]) {
        this.runAction(() => this.handleImportFile(e.target.files[0]));
        e.target.value = '';
      }
    });

    // ルールタブ: 選択モードボタン
    document.getElementById('bulkTagBtn').addEventListener('click', () => this.bulkTagRules());
    document.getElementById('exportSelectedBtn').addEventListener('click', () => this.exportRules(true));
    document.getElementById('bulkDeleteBtn').addEventListener('click', () => this.runAction(() => this.bulkDeleteRules()));
    document.getElementById('clearSelectionBtn').addEventListener('click', () => this.clearSelection());
  }

  updateTabPanels() {
    const panels = document.querySelectorAll('.tab-panel');
    panels.forEach(panel => panel.classList.remove('active'));

    if (this.activeTab === 'traffic') {
      document.getElementById('trafficPanel').classList.add('active');
    } else if (this.activeTab === 'rules') {
      document.getElementById('rulesPanel').classList.add('active');
    }
  }

  startListening() {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'UPDATE_COUNTS' && message.tabId === this.currentTabId) {
        const oldCounts = { ...this.domainData.domain_counts };
        // domain_rulesは変更時のみ含まれる
        const rules = message.data.domain_rules;
        if (!rules) {
          message.data.domain_rules = this.domainRules;
        }
        this.domainData = message.data;
        if (rules) {
          this.domainRules = rules;
        }
        this.render(oldCounts);
      } else if (message.type === 'SITE_POLICY_UPDATED') {
        const currentSiteDomain = this.domainData.site_policy?.site_domain;
        if (message.siteDomain === currentSiteDomain) {
          this.domainData.site_policy = message.sitePolicy;
          this.render();
        }
      }
    });
  }

  async loadData() {
    if (this.currentTabId === null) return;

    try {
      const response = await this.request({
        type: 'GET_TAB_DATA',
        tabId: this.currentTabId
      });
      this.domainData = response;
      this.domainRules = response.domain_rules || {};
      this.render();
    } catch (error) {
      console.error('Failed to load data:', error);
    }
  }

  async clearCounts() {
    if (this.currentTabId === null) return;

    await this.request({
      type: 'CLEAR_COUNTS',
      tabId: this.currentTabId
    });

    this.domainData.domain_counts = {};
    this.render();
  }

  setPolicyScope(scope) {
    if (scope !== 'global' && scope !== 'site') return;
    this.policyScope = scope;
    this.render();
  }

  async handlePolicyBuilderAction() {
    if (this.policyScope === 'site') {
      await this.toggleSitePolicy();
    } else {
      await this.allowCurrentSite();
    }
  }

  async toggleSitePolicy() {
    const siteDomain = this.domainData.site_policy?.site_domain || getDomainRoot(this.domainData.main_domain);
    if (!siteDomain) return;
    const enabled = Boolean(this.domainData.site_policy?.enabled);

    if (enabled) {
      const confirmed = await this.confirmAction({
        title: 'このサイトの保護を解除',
        message: `${siteDomain} 専用の停止ルールを無効にします。保存したサイト専用ルールは残ります。`,
        confirmLabel: '保護を解除'
      });
      if (!confirmed) return;
    }

    const response = await this.request({
      type: enabled ? 'DISABLE_SITE_POLICY' : 'ENABLE_SITE_POLICY',
      siteDomain
    });
    this.domainData.site_policy = response.site_policy;
    this.render();
    this.showToast(enabled
      ? `${siteDomain} のサイト保護を解除しました`
      : `${siteDomain} 内の未登録通信を停止します`);
  }

  async toggleBlock(domain) {
    if (this.policyScope === 'site') {
      await this.toggleSiteRule(domain, 'block');
      return;
    }

    const effectiveRule = this.getGlobalPolicyRule(domain);
    const hasExactBlock = effectiveRule?.action === 'block' && !effectiveRule.inherited;
    const messageType = hasExactBlock ? 'UNBLOCK_DOMAIN' : 'BLOCK_DOMAIN';

    const response = await this.request({
      type: messageType,
      domain
    });

    if (response.success) {
      this.domainData.blocked_domains = response.blocked_domains;
      this.domainRules = response.domain_rules || this.domainRules;
      this.render();
    }
  }

  async toggleAllow(domain) {
    if (this.policyScope === 'site') {
      await this.toggleSiteRule(domain, 'allow');
      return;
    }

    const effectiveRule = this.getGlobalPolicyRule(domain);
    const hasExactAllow = effectiveRule?.action === 'allow' && !effectiveRule.inherited;
    if (hasExactAllow) {
      await this.disallowDomain(domain);
    } else {
      await this.allowDomain(domain);
    }
  }

  async bulkPolicyAction() {
    if (this.policyScope === 'site') {
      await this.bulkAllowSiteDomains();
      return;
    }
    if (this.domainData.mode === 'strict') {
      await this.bulkAllow();
    } else {
      await this.bulkBlock();
    }
  }

  async toggleSiteRule(domain, action) {
    const sitePolicy = this.domainData.site_policy;
    if (!sitePolicy?.enabled || !sitePolicy.site_domain) {
      this.showToast('先に「サイト保護を開始」を選んでください', 'error');
      return;
    }

    const scopedRule = this.getScopedControlRule(domain);
    const hasExactRule = scopedRule?.action === action && !scopedRule.inherited;
    const response = await this.request({
      type: hasExactRule ? 'DELETE_SITE_RULE' : 'SET_SITE_RULE',
      siteDomain: sitePolicy.site_domain,
      domain,
      ...(hasExactRule ? {} : { action })
    });
    this.domainData.site_policy = response.site_policy;
    this.render();
  }

  async bulkAllowSiteDomains() {
    const sitePolicy = this.domainData.site_policy;
    if (!sitePolicy?.enabled || !sitePolicy.site_domain) {
      this.showToast('先に「サイト保護を開始」を選んでください', 'error');
      return;
    }

    const visibleDomains = this.getSortedDomains()
      .map(([domain]) => domain)
      .filter(domain => this.getSitePolicyRule(domain)?.action !== 'allow');
    if (visibleDomains.length === 0) {
      this.showToast('表示中のドメインはすべてサイト内で許可済みです');
      return;
    }

    const confirmed = await this.confirmAction({
      title: 'このサイト内で表示中の通信を許可',
      message: `${visibleDomains.length}件を ${sitePolicy.site_domain} 専用の許可リストへ追加します。他サイトには影響しません。`,
      confirmLabel: 'サイト内で許可',
      danger: false
    });
    if (!confirmed) return;

    const response = await this.request({
      type: 'BULK_ALLOW_SITE_DOMAINS',
      siteDomain: sitePolicy.site_domain,
      domains: visibleDomains
    });
    this.domainData.site_policy = response.site_policy;
    this.render();
    this.showToast(`${visibleDomains.length}件をこのサイト内で許可しました`);
  }

  async toggleTemporaryAllow(domain) {
    const sitePolicy = this.domainData.site_policy;
    if (!sitePolicy?.enabled || !sitePolicy.site_domain) return;
    const expiresAt = Number(sitePolicy.temporary_allows?.[domain] || 0);
    const isActive = expiresAt > Date.now();
    const response = await this.request({
      type: isActive ? 'REMOVE_TEMPORARY_SITE_ALLOW' : 'TEMPORARILY_ALLOW_SITE_DOMAIN',
      siteDomain: sitePolicy.site_domain,
      domain
    });
    this.domainData.site_policy = response.site_policy;
    this.render();
    this.showToast(isActive ? `${domain} の一時許可を解除しました` : `${domain} を5分だけ許可しました`);
  }

  // 表示中のドメインをすべてブロック
  async bulkBlock() {
    const visibleDomains = this.getSortedDomains().map(([domain]) => domain);
    if (visibleDomains.length === 0) return;

    const confirmed = await this.confirmAction({
      title: '表示中の通信をブロック',
      message: `${visibleDomains.length}件のドメインをブロックします。この設定は全タブに影響します。`,
      confirmLabel: 'ブロック'
    });
    if (!confirmed) return;

    const response = await this.request({
      type: 'BULK_BLOCK',
      domains: visibleDomains
    });

    if (response.success) {
      this.domainData.blocked_domains = response.blocked_domains;
      this.domainRules = response.domain_rules || this.domainRules;
      this.render();
    }
  }

  // 厳格モードで、現在の絞り込み結果を許可リストへ追加する
  async bulkAllow() {
    const visibleDomains = this.getSortedDomains()
      .map(([domain]) => domain)
      .filter(domain => this.getGlobalPolicyRule(domain)?.action !== 'allow');
    if (visibleDomains.length === 0) {
      this.showToast('表示中のドメインはすべて許可済みです');
      return;
    }

    const confirmed = await this.confirmAction({
      title: '表示中の通信を許可',
      message: `${visibleDomains.length}件のドメインを許可します。より広い親ルールがある場合も、このドメインの例外が優先されます。`,
      confirmLabel: '許可する',
      danger: false
    });
    if (!confirmed) return;

    const response = await this.request({
      type: 'BULK_ALLOW',
      domains: visibleDomains
    });

    if (response.success) {
      this.domainData.blocked_domains = response.blocked_domains;
      this.domainData.allowed_domains = response.allowed_domains;
      this.domainRules = response.domain_rules || this.domainRules;
      this.render();
      this.showToast(`${visibleDomains.length}件を許可しました`);
    }
  }

  async allowCurrentSite() {
    const domain = this.domainData.main_domain;
    if (!domain) return;
    const effectiveRule = this.getEffectivePolicyRule(domain);
    if (effectiveRule?.action === 'allow') return;
    await this.allowDomain(domain);
    this.showToast(`${domain} を許可しました`);
  }

  // モード切り替え
  async toggleMode() {
    const modeToggle = document.getElementById('modeToggle');
    const newMode = modeToggle.checked ? 'strict' : 'normal';

    // 厳格モードON時は警告
    if (newMode === 'strict') {
      const confirmed = await this.confirmAction({
        title: '厳格モードに切り替え',
        message: '全タブで、許可していないドメインへの通信とサイト表示をすべてブロックします。先に必要なドメインを許可するか、戻せる状態で切り替えてください。',
        confirmLabel: '切り替える'
      });
      if (!confirmed) {
        modeToggle.checked = false;
        return;
      }
    }

    const response = await this.request({
      type: 'SET_MODE',
      mode: newMode
    });

    if (response.success) {
      this.domainData.mode = response.mode;
      this.domainData.allowed_domains = response.allowed_domains;
      this.domainRules = response.domain_rules || this.domainRules;
      this.updateModeUI();
      this.render();
    }
  }

  // ブロック機能を切り替え
  async toggleBlocking() {
    const blockingSwitch = document.getElementById('blockingSwitch');
    const enabled = blockingSwitch.checked;

    const response = await this.request({
      type: enabled ? 'ENABLE_BLOCKING' : 'DISABLE_BLOCKING'
    });

    if (response.success) {
      this.domainData.blocking_enabled = response.blocking_enabled;
      this.updateBlockingUI();
      await this.loadData();
    }
  }

  // ブロック機能UIを更新
  updateBlockingUI() {
    const enabled = this.domainData.blocking_enabled;
    const blockingSwitch = document.getElementById('blockingSwitch');
    const blockingLabel = document.getElementById('blockingLabel');
    const modeToggle = document.getElementById('modeToggle');
    const container = document.querySelector('.container');

    blockingSwitch.checked = enabled;
    blockingLabel.textContent = enabled ? 'ON' : 'OFF';
    blockingLabel.classList.toggle('off', !enabled);
    modeToggle.disabled = !enabled;
    container.classList.toggle('blocking-disabled', !enabled);
  }

  // モードUIを更新
  updateModeUI() {
    const mode = this.domainData.mode;
    const modeToggle = document.getElementById('modeToggle');
    const modeDescription = document.getElementById('modeDescription');
    const normalLabel = document.getElementById('normalModeLabel');
    const strictLabel = document.getElementById('strictModeLabel');
    const container = document.querySelector('.container');

    modeToggle.checked = mode === 'strict';

    if (mode === 'strict') {
      modeDescription.textContent = '未許可の全ドメインを停止。サイト表示も許可リスト方式になります';
      normalLabel.classList.remove('active');
      strictLabel.classList.add('active');
      container.classList.add('strict-mode');
    } else {
      modeDescription.textContent = '指定したドメインのみブロック（ブラックリスト方式）';
      normalLabel.classList.add('active');
      strictLabel.classList.remove('active');
      container.classList.remove('strict-mode');
    }
  }

  isDomainEffectivelyBlocked(domain) {
    if (!this.domainData.blocking_enabled) return false;
    const effectiveRule = this.getEffectivePolicyRule(domain);
    if (effectiveRule) return effectiveRule.action === 'block';
    if (this.domainData.mode !== 'strict') return false;
    return true;
  }

  // ドメインを許可（厳格モードまたは親ブロックの例外）
  async allowDomain(domain) {
    const response = await this.request({
      type: 'ALLOW_DOMAIN',
      domain
    });

    if (response.success) {
      this.domainData.allowed_domains = response.allowed_domains;
      this.domainRules = response.domain_rules || this.domainRules;
      this.render();
    }
  }

  // ドメインの許可を解除
  async disallowDomain(domain) {
    const response = await this.request({
      type: 'DISALLOW_DOMAIN',
      domain
    });

    if (response.success) {
      this.domainData.allowed_domains = response.allowed_domains;
      this.domainRules = response.domain_rules || this.domainRules;
      this.render();
    }
  }

  getSortedDomains() {
    const { domain_counts } = this.domainData;
    let domains = Object.entries(domain_counts);

    // トラフィックフィルタ
    if (this.trafficFilter === 'passing') {
      domains = domains.filter(([domain]) => !this.isDomainEffectivelyBlocked(domain));
    } else if (this.trafficFilter === 'blocked') {
      domains = domains.filter(([domain]) => this.isDomainEffectivelyBlocked(domain));
    } else if (this.trafficFilter === 'ad') {
      domains = domains.filter(([domain]) =>
        this.isLikelyAd(domain)
      );
    } else if (this.trafficFilter === '3p') {
      domains = domains.filter(([domain]) =>
        this.isThirdParty(domain)
      );
    }

    // 検索フィルタリング
    const trafficSearch = this.searchQueries.traffic;
    if (trafficSearch) {
      domains = domains.filter(([domain]) =>
        domain.toLowerCase().includes(trafficSearch)
      );
    }

    // ソート
    if (this.sortBy === 'count') {
      domains.sort((a, b) => {
        const countA = typeof a[1] === 'object' ? a[1].total : a[1];
        const countB = typeof b[1] === 'object' ? b[1].total : b[1];
        return countB - countA;
      });
    } else {
      domains.sort((a, b) => a[0].localeCompare(b[0]));
    }

    return domains;
  }

  render(oldCounts = {}) {
    this.updateBlockingUI();
    this.updateModeUI();
    // getSortedDomainsの結果をキャッシュしてrenderTrafficListとupdateBulkActionsで共有
    this._cachedSortedDomains = this.getSortedDomains();
    this.renderTrafficList(oldCounts);
    // 編集中・追加フォーム表示中はルールリストの再描画をスキップ（入力が消えるのを防止）
    if (!this.editingRuleDomain && !this.showingAddForm) {
      this.renderRulesList();
    }
    this.updateStats();
    this.updateBulkActions();
    this.updatePolicyBuilder();
    this.updateRulesToolbar();
    this.updateTabCounts();
    this._cachedSortedDomains = null;
  }

  updateTabCounts() {
    const rulesCount = Object.keys(this.domainRules).length;
    const rulesTabCount = document.getElementById('rulesTabCount');
    rulesTabCount.textContent = rulesCount;
    rulesTabCount.dataset.count = rulesCount;
  }

  updateBulkActions() {
    const sortedDomains = this._cachedSortedDomains || this.getSortedDomains();
    const visibleCount = sortedDomains.length;

    document.getElementById('visibleCount').textContent = visibleCount;

    const bulkBlockBtn = document.getElementById('bulkBlockBtn');
    const isSiteScope = this.policyScope === 'site';
    const sitePolicyEnabled = Boolean(this.domainData.site_policy?.enabled);
    bulkBlockBtn.disabled = visibleCount === 0 || !this.domainData.blocking_enabled || (isSiteScope && !sitePolicyEnabled);
    const isStrictMode = isSiteScope || this.domainData.mode === 'strict';
    bulkBlockBtn.classList.toggle('bulk-allow', isStrictMode);
    bulkBlockBtn.classList.toggle('bulk-block', !isStrictMode);

    if (isSiteScope) {
      bulkBlockBtn.title = sitePolicyEnabled
        ? '表示中のドメインをこのサイト専用の許可リストへ追加'
        : '先にサイト保護を開始してください';
      bulkBlockBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <path d="m8.5 12 2.3 2.3 4.7-4.8"/>
        </svg>
        ${this.searchQueries.traffic ? '絞り込みをサイト許可' : '表示中をサイト許可'}
      `;
    } else if (isStrictMode) {
      bulkBlockBtn.title = '表示中のドメインを許可リストへ追加';
      bulkBlockBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <path d="m8.5 12 2.3 2.3 4.7-4.8"/>
        </svg>
        ${this.searchQueries.traffic ? '絞り込みを許可' : '表示中を許可'}
      `;
    } else if (this.searchQueries.traffic) {
      bulkBlockBtn.title = '絞り込み結果をすべてブロック';
      bulkBlockBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
        </svg>
        絞り込みをブロック
      `;
    } else {
      bulkBlockBtn.title = '表示中をすべてブロック';
      bulkBlockBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
        </svg>
        すべてブロック
      `;
    }
  }

  updatePolicyBuilder() {
    const button = document.getElementById('allowCurrentSiteBtn');
    const buttonLabel = button.querySelector('span');
    const kicker = document.getElementById('policyBuilderKicker');
    const title = document.getElementById('policyBuilderTitle');
    const hint = document.getElementById('policyBuilderHint');
    const domain = this.domainData.main_domain;
    const isSiteScope = this.policyScope === 'site';
    document.querySelectorAll('[data-policy-scope]').forEach(scopeButton => {
      const active = scopeButton.dataset.policyScope === this.policyScope;
      scopeButton.classList.toggle('active', active);
      scopeButton.setAttribute('aria-pressed', String(active));
    });

    if (isSiteScope) {
      const sitePolicy = this.domainData.site_policy || {};
      const siteDomain = sitePolicy.site_domain || getDomainRoot(domain);
      const enabled = Boolean(sitePolicy.enabled);
      const ruleCount = Object.keys(sitePolicy.rules || {}).length;
      const temporaryCount = Object.values(sitePolicy.temporary_allows || {})
        .filter(expiresAt => Number(expiresAt) > Date.now()).length;

      kicker.textContent = enabled ? 'SITE POLICY · ON' : 'SITE POLICY';
      title.textContent = siteDomain ? `${siteDomain} 専用ポリシー` : 'このページは対象外';
      hint.textContent = !siteDomain
        ? '通常のWebページを開いてから設定してください'
        : enabled
          ? `${ruleCount}件を登録${temporaryCount ? `・一時許可 ${temporaryCount}件` : ''}。未登録通信はこのサイト内だけ停止します${sitePolicy.precise_scope ? '' : '（互換スコープ）'}`
          : 'このサイト内だけ、未登録の外部通信を既定で停止します。サイト本体は自動で許可します';
      button.disabled = !siteDomain || !this.domainData.blocking_enabled;
      button.classList.remove('is-allowed');
      button.classList.toggle('is-danger', enabled);
      buttonLabel.textContent = enabled ? 'サイト保護を解除' : 'サイト保護を開始';
      button.title = sitePolicy.precise_scope || !enabled
        ? ''
        : 'Chrome 145未満では送信元ドメインを使う互換スコープです';
      return;
    }

    button.classList.remove('is-danger');
    const effectiveRule = domain ? this.getGlobalPolicyRule(domain) : null;
    const isAllowed = effectiveRule?.action === 'allow';
    const isStrictMode = this.domainData.mode === 'strict';

    kicker.textContent = isStrictMode ? 'STRICT ALLOWLIST' : 'ALLOWLIST BUILDER';
    title.textContent = isStrictMode ? '必要な通信だけを通す' : '現在のサイトを起点にする';
    hint.textContent = isStrictMode
      ? '未許可の通信は停止中です。現在サイトや表示中の依存先を選んで許可します'
      : '先に許可しておくと、厳格モードで必要な外部通信を段階的に追加できます';

    button.disabled = !domain || !this.domainData.blocking_enabled || isAllowed;
    button.classList.toggle('is-allowed', isAllowed);
    buttonLabel.textContent = !domain
      ? 'このページは対象外'
      : isAllowed
        ? effectiveRule.inherited ? `${effectiveRule.domain} から許可` : '現在サイトは許可済み'
        : '現在サイトを許可';
    button.title = isAllowed && effectiveRule.inherited
      ? `${effectiveRule.domain} の許可ルールを継承しています`
      : '';
  }

  updateStats() {
    const totalDomains = Object.keys(this.domainData.domain_counts).length;
    const totalRequests = Object.values(this.domainData.domain_counts).reduce((acc, data) => {
      const count = typeof data === 'object' ? data.total : data;
      return acc + count;
    }, 0);

    document.getElementById('totalDomains').textContent = totalDomains;
    document.getElementById('totalRequests').textContent = totalRequests;

    const currentSite = document.getElementById('currentSite');
    if (currentSite) {
      currentSite.textContent = this.domainData.main_domain || 'このページでは計測できません';
      currentSite.title = this.domainData.main_domain || '';
    }
  }

  // リソースタイプのバッジを生成
  renderTypeBadges(types) {
    if (!types || Object.keys(types).length === 0) return '';

    const typeOrder = ['JS', 'XHR', 'IMG', 'CSS', 'FONT', 'FRAME', 'MEDIA', 'DOC', 'PING', 'WS', 'OTHER'];

    return typeOrder
      .filter(type => types[type])
      .map(type => `<span class="type-badge type-${type.toLowerCase()}">${type}:${types[type]}</span>`)
      .join('');
  }

  renderTrafficList(oldCounts = {}) {
    const domainList = document.getElementById('domainList');
    const emptyState = document.getElementById('emptyState');
    const sortedDomains = this._cachedSortedDomains || this.getSortedDomains();

    if (sortedDomains.length === 0) {
      emptyState.style.display = 'flex';
      const items = domainList.querySelectorAll('.domain-item');
      items.forEach(item => item.remove());
      return;
    }

    emptyState.style.display = 'none';

    const isStrictMode = (this.domainData.mode === 'strict' || this.domainData.site_policy?.enabled) && this.domainData.blocking_enabled;

    const currentDomains = new Set(sortedDomains.map(([d]) => d));

    const existingElements = new Map();
    domainList.querySelectorAll('.domain-item').forEach(item => {
      const domain = item.dataset.domain;
      if (domain) {
        existingElements.set(domain, item);
      }
    });

    existingElements.forEach((item, domain) => {
      if (!currentDomains.has(domain)) {
        item.remove();
        existingElements.delete(domain);
      }
    });

    sortedDomains.forEach(([domain, data], index) => {
      const effectiveRule = this.getEffectivePolicyRule(domain);
      const controlRule = this.getScopedControlRule(domain);
      const temporaryRule = this.getTemporarySiteRule(domain);
      const isAllowed = effectiveRule?.action === 'allow';
      const isBlocked = this.isDomainEffectivelyBlocked(domain);
      const isAd = this.isLikelyAd(domain);
      const isSafe = this.isLikelySafe(domain);
      const isThirdParty = this.isThirdParty(domain);
      const isFirstParty = this.isFirstParty(domain);
      const stateSignature = [
        this.domainData.blocking_enabled, isStrictMode, isAllowed, isBlocked, isAd, isSafe, isThirdParty,
        isFirstParty, effectiveRule?.domain || '', effectiveRule?.action || '', effectiveRule?.source || '',
        controlRule?.domain || '', controlRule?.action || '', temporaryRule?.domain || '', this.policyScope
      ].join(':');

      const count = typeof data === 'object' ? data.total : data;
      const types = typeof data === 'object' ? data.types : null;
      const oldCount = oldCounts[domain] ? (typeof oldCounts[domain] === 'object' ? oldCounts[domain].total : oldCounts[domain]) : undefined;
      const wasUpdated = oldCount !== undefined && oldCount !== count;

      let item = existingElements.get(domain);
      let isNewItem = false;

      if (item && item.dataset.state !== stateSignature) {
        const replacement = this.createDomainItem(
          domain, data, isStrictMode, isAllowed, isBlocked, isAd, isSafe, isThirdParty, wasUpdated
        );
        item.replaceWith(replacement);
        item = replacement;
        existingElements.set(domain, item);
      }

      if (item) {
        const countBadge = item.querySelector('.count-badge');
        if (countBadge) {
          countBadge.textContent = count;
          if (wasUpdated) {
            countBadge.classList.add('updated');
            setTimeout(() => countBadge.classList.remove('updated'), 300);
          }
        }

        const typeBadges = item.querySelector('.type-badges');
        if (typeBadges) {
          typeBadges.innerHTML = this.renderTypeBadges(types);
        }

      } else {
        item = this.createDomainItem(domain, data, isStrictMode, isAllowed, isBlocked, isAd, isSafe, isThirdParty, wasUpdated);
        existingElements.set(domain, item);
        isNewItem = true;
      }

      const allItems = Array.from(domainList.querySelectorAll('.domain-item'));
      const currentIndex = allItems.indexOf(item);

      if (isNewItem || currentIndex !== index) {
        if (index === 0) {
          const firstItem = domainList.querySelector('.domain-item');
          if (firstItem) {
            domainList.insertBefore(item, firstItem);
          } else {
            domainList.appendChild(item);
          }
        } else {
          const prevDomain = sortedDomains[index - 1][0];
          const prevItem = existingElements.get(prevDomain);
          if (prevItem && prevItem.parentNode) {
            prevItem.after(item);
          } else {
            domainList.appendChild(item);
          }
        }
      }
    });
  }

  createDomainItem(domain, data, isStrictMode, isAllowed, isBlocked, isAd, isSafe, isThirdParty, wasUpdated) {
    const count = typeof data === 'object' ? data.total : data;
    const types = typeof data === 'object' ? data.types : null;
    const effectiveRule = this.getEffectivePolicyRule(domain);
    const controlRule = this.getScopedControlRule(domain);
    const temporaryRule = this.getTemporarySiteRule(domain);
    const hasExactAllow = controlRule?.action === 'allow' && !controlRule.inherited;
    const hasExactBlock = controlRule?.action === 'block' && !controlRule.inherited;
    const isFirstParty = this.isFirstParty(domain);

    let tags = '';
    if (isBlocked) {
      tags += '<span class="domain-tag tag-blocked" title="ブロック中">停止</span>';
    } else if (isAllowed) {
      tags += '<span class="domain-tag tag-allowed" title="許可ルールが適用中">許可</span>';
    }
    if (effectiveRule?.source === 'temporary') {
      tags += '<span class="domain-tag tag-temporary" title="5分間の一時許可が適用中">一時</span>';
    } else if (effectiveRule?.source === 'site' || effectiveRule?.source === 'site-default') {
      tags += '<span class="domain-tag tag-site" title="このサイト専用ポリシーが適用中">サイト</span>';
    }
    if (effectiveRule?.inherited && !effectiveRule.defaultRule) {
      tags += `<span class="domain-tag tag-inherited" title="${this.escapeHtml(effectiveRule.domain)} のルールを継承">親ルール</span>`;
    }
    if (isAd) {
      tags += '<span class="domain-tag tag-ad" title="広告/トラッキングの可能性">広告</span>';
    }
    if (isSafe) {
      tags += '<span class="domain-tag tag-safe" title="既知のCDN/ライブラリ配信元（推定）">CDN候補</span>';
    }
    if (isThirdParty) {
      tags += '<span class="domain-tag tag-3p" title="サードパーティ">3rd</span>';
    } else if (isFirstParty) {
      tags += '<span class="domain-tag tag-1p" title="現在サイトと同じ登録ドメイン">1st</span>';
    }

    const item = document.createElement('div');
    item.dataset.domain = domain;
    item.dataset.state = [
      this.domainData.blocking_enabled, isStrictMode, isAllowed, isBlocked, isAd, isSafe, isThirdParty,
      isFirstParty, effectiveRule?.domain || '', effectiveRule?.action || '', effectiveRule?.source || '',
      controlRule?.domain || '', controlRule?.action || '', temporaryRule?.domain || '', this.policyScope
    ].join(':');
    item.dataset.new = 'true';
    setTimeout(() => delete item.dataset.new, 200);

    let itemClass = 'domain-item';
    if (isStrictMode) {
      if (isBlocked) {
        itemClass += ' blocked';
      } else if (isAllowed) {
        itemClass += ' allowed';
      }
    } else if (isBlocked) {
      itemClass += ' explicitly-blocked';
    } else if (isAllowed) {
      itemClass += ' allowed';
    }
    if (isAd) {
      itemClass += ' likely-ad';
    }

    item.className = itemClass;

    const siteScopeUnavailable = this.policyScope === 'site' && !this.domainData.site_policy?.enabled;
    const isRequiredSiteOrigin = this.policyScope === 'site' &&
      (domain === this.domainData.main_domain || domain === this.domainData.site_policy?.site_domain);
    const controlsDisabled = !this.domainData.blocking_enabled || siteScopeUnavailable;
    const allowInherited = controlRule?.action === 'allow' && controlRule.inherited;
    const blockInherited = controlRule?.action === 'block' && controlRule.inherited;
    const scopeLabel = this.policyScope === 'site' ? 'このサイト内で' : '全タブで';
    const allowTitle = isRequiredSiteOrigin
      ? 'サイト本体は保護の起点として常に許可されます'
      : allowInherited
      ? `${controlRule.domain} の許可を継承中。個別に止めるにはブロックを選択`
      : hasExactAllow ? `${scopeLabel}このドメインの許可ルールを削除` : `${scopeLabel}このドメインを許可`;
    const blockTitle = isRequiredSiteOrigin
      ? 'サイト本体はサイト保護の起点として常に許可されます'
      : blockInherited
      ? `${controlRule.domain} のブロックを継承中。個別に通すには許可を選択`
      : hasExactBlock ? `${scopeLabel}このドメインのブロックルールを削除` : `${scopeLabel}このドメインをブロック`;
    const exactTemporaryAllow = temporaryRule && !temporaryRule.inherited;
    const temporaryTitle = isRequiredSiteOrigin
      ? 'サイト本体はすでに許可されています'
      : temporaryRule?.inherited
      ? `${temporaryRule.domain} の一時許可を継承中`
      : exactTemporaryAllow ? '5分間の一時許可を解除' : 'このサイト内で5分だけ許可';
    const temporaryButton = this.policyScope === 'site' ? `
      <button class="temporary-allow-btn${exactTemporaryAllow ? ' active' : ''}${temporaryRule?.inherited ? ' inherited' : ''}" title="${this.escapeHtml(temporaryTitle)}" aria-label="${this.escapeHtml(temporaryTitle)}"${controlsDisabled || temporaryRule?.inherited || isRequiredSiteOrigin ? ' disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>
        </svg>
      </button>
    ` : '';
    const actionButtons = `
      <button class="allow-btn${controlRule?.action === 'allow' ? ' active' : ''}${allowInherited ? ' inherited' : ''}" title="${this.escapeHtml(allowTitle)}" aria-label="${this.escapeHtml(allowTitle)}"${controlsDisabled || allowInherited || isRequiredSiteOrigin ? ' disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/>
        </svg>
      </button>
      <button class="block-btn${controlRule?.action === 'block' ? ' active' : ''}${blockInherited ? ' inherited' : ''}" title="${this.escapeHtml(blockTitle)}" aria-label="${this.escapeHtml(blockTitle)}"${controlsDisabled || blockInherited || isRequiredSiteOrigin ? ' disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
        </svg>
      </button>
      ${temporaryButton}
    `;

    item.innerHTML = `
      <div class="domain-info">
        <div class="domain-header">
          <div class="domain-name" title="${this.escapeHtml(domain)}">${this.escapeHtml(domain)}</div>
          <div class="domain-tags">${tags}</div>
        </div>
        <div class="domain-meta">
          <span class="request-count">
            <span class="count-badge${wasUpdated ? ' updated' : ''}">${count}</span>
          </span>
          <div class="type-badges">${this.renderTypeBadges(types)}</div>
        </div>
      </div>
      <div class="domain-actions">
        ${actionButtons}
      </div>
    `;

    const blockBtn = item.querySelector('.block-btn');
    if (blockBtn) {
      blockBtn.addEventListener('click', () => this.runAction(() => this.toggleBlock(domain)));
    }

    const allowBtn = item.querySelector('.allow-btn');
    if (allowBtn) {
      allowBtn.addEventListener('click', () => this.runAction(() => this.toggleAllow(domain)));
    }

    const temporaryAllowBtn = item.querySelector('.temporary-allow-btn');
    if (temporaryAllowBtn) {
      temporaryAllowBtn.addEventListener('click', () => this.runAction(() => this.toggleTemporaryAllow(domain)));
    }

    return item;
  }

  // ========================================
  // Rules Tab
  // ========================================

  renderRulesList() {
    const rulesList = document.getElementById('rulesList');
    const emptyState = document.getElementById('rulesEmptyState');
    const rules = this.domainRules;
    const ruleEntries = Object.entries(rules);

    // 検索フィルタ
    let filtered = ruleEntries;
    const rulesSearch = this.searchQueries.rules;
    if (rulesSearch) {
      filtered = ruleEntries.filter(([domain, rule]) =>
        domain.toLowerCase().includes(rulesSearch) ||
        (rule.memo && rule.memo.toLowerCase().includes(rulesSearch)) ||
        (rule.tags && rule.tags.some(t => t.toLowerCase().includes(rulesSearch)))
      );
    }

    // ルール件数を更新
    document.getElementById('rulesCount').textContent = filtered.length;

    // 空状態
    if (filtered.length === 0) {
      emptyState.style.display = 'flex';
      // アコーディオングループをクリア
      rulesList.querySelectorAll('.rules-group, .add-rule-form').forEach(el => el.remove());
      // 追加フォームが開いている場合は再描画
      if (this.showingAddForm) {
        this.insertAddRuleForm(rulesList, emptyState);
      }
      return;
    }

    emptyState.style.display = 'none';

    // タグでグループ化
    const groups = new Map(); // tag -> [{domain, rule}]
    const noTag = [];

    filtered.forEach(([domain, rule]) => {
      if (rule.tags && rule.tags.length > 0) {
        rule.tags.forEach(tag => {
          if (!groups.has(tag)) {
            groups.set(tag, []);
          }
          groups.get(tag).push({ domain, rule });
        });
      } else {
        noTag.push({ domain, rule });
      }
    });

    // タグ名でソート
    const sortedTags = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));

    // DOM構築
    const fragment = document.createDocumentFragment();

    // 追加フォーム
    if (this.showingAddForm) {
      fragment.appendChild(this.createAddRuleFormElement());
    }

    // タグ付きグループ
    sortedTags.forEach(tag => {
      const items = groups.get(tag);
      fragment.appendChild(this.createRulesGroup(tag, items));
    });

    // タグなしグループ
    if (noTag.length > 0) {
      fragment.appendChild(this.createRulesGroup('タグなし', noTag));
    }

    // スクロール位置を保存して再描画
    const scrollTop = rulesList.scrollTop;
    rulesList.querySelectorAll('.rules-group, .add-rule-form').forEach(el => el.remove());
    rulesList.insertBefore(fragment, emptyState);
    rulesList.scrollTop = scrollTop;
  }

  createRulesGroup(tag, items) {
    const group = document.createElement('div');
    group.className = 'rules-group';
    if (this.expandedTags.has(tag)) {
      group.classList.add('expanded');
    }

    // グループ内のドメイン一覧（重複除去済み）
    const groupDomains = [...new Set(items.map(i => i.domain))];
    const allChecked = groupDomains.length > 0 && groupDomains.every(d => this.selectedRules.has(d));

    const header = document.createElement('div');
    header.className = 'rules-group-header';
    header.innerHTML = `
      <input type="checkbox" class="rules-group-checkbox" aria-label="${this.escapeHtml(tag)} のルールをすべて選択" ${allChecked ? 'checked' : ''}>
      <button type="button" class="rules-group-toggle" aria-expanded="${this.expandedTags.has(tag)}">
        <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        <span class="rules-group-title">${this.escapeHtml(tag)}</span>
        <span class="rules-group-count">${items.length}</span>
      </button>
    `;

    // グループチェックボックスイベント
    const groupCheckbox = header.querySelector('.rules-group-checkbox');
    groupCheckbox.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    groupCheckbox.addEventListener('change', (e) => {
      const checked = e.target.checked;
      groupDomains.forEach(domain => {
        if (checked) {
          this.selectedRules.add(domain);
        } else {
          this.selectedRules.delete(domain);
        }
      });
      // グループ内のアイテムチェックボックスを同期
      group.querySelectorAll('.rule-item-checkbox').forEach(cb => {
        cb.checked = checked;
        const ruleItem = cb.closest('.rule-item');
        if (ruleItem) {
          ruleItem.classList.toggle('selected', checked);
        }
      });
      this.updateRulesToolbar();
    });

    const toggleButton = header.querySelector('.rules-group-toggle');
    const toggleGroup = () => {
      if (this.expandedTags.has(tag)) {
        this.expandedTags.delete(tag);
      } else {
        this.expandedTags.add(tag);
      }
      group.classList.toggle('expanded');
      toggleButton.setAttribute('aria-expanded', String(group.classList.contains('expanded')));
    };

    toggleButton.addEventListener('click', toggleGroup);

    const body = document.createElement('div');
    body.className = 'rules-group-body';

    // ドメイン名でソート（重複除去はしない、同一ドメインが複数タグに属する場合あり）
    const uniqueDomains = new Map();
    items.forEach(item => {
      if (!uniqueDomains.has(item.domain)) {
        uniqueDomains.set(item.domain, item);
      }
    });

    Array.from(uniqueDomains.values())
      .sort((a, b) => a.domain.localeCompare(b.domain))
      .forEach(({ domain, rule }) => {
        body.appendChild(this.createRuleItem(domain, rule));
      });

    group.appendChild(header);
    group.appendChild(body);
    return group;
  }

  createRuleItem(domain, rule) {
    const item = document.createElement('div');
    item.className = `rule-item ${rule.action}`;
    item.dataset.domain = domain;

    if (this.selectedRules.has(domain)) {
      item.classList.add('selected');
    }

    const tagsHtml = (rule.tags || [])
      .map(t => `<span class="rule-tag-chip">${this.escapeHtml(t)}</span>`)
      .join('');

    const memoHtml = rule.memo
      ? `<span class="rule-item-memo" title="${this.escapeHtml(rule.memo)}">${this.escapeHtml(rule.memo)}</span>`
      : '';

    item.innerHTML = `
      <div class="rule-item-row">
        <input type="checkbox" class="rule-item-checkbox" aria-label="${this.escapeHtml(domain)} を選択" ${this.selectedRules.has(domain) ? 'checked' : ''}>
        <div class="rule-item-info">
          <div class="rule-item-domain" title="${this.escapeHtml(domain)}">${this.escapeHtml(domain)}</div>
          <div class="rule-item-meta">
            <span class="rule-action-badge ${rule.action}">${rule.action === 'block' ? 'ブロック' : '許可'}</span>
            ${memoHtml}
            <div class="rule-item-tags">${tagsHtml}</div>
          </div>
        </div>
        <div class="rule-item-actions">
          <button class="edit-btn" title="編集" aria-label="${this.escapeHtml(domain)} のルールを編集">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="delete-btn" title="削除" aria-label="${this.escapeHtml(domain)} のルールを削除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    // チェックボックスイベント
    const checkbox = item.querySelector('.rule-item-checkbox');
    checkbox.addEventListener('change', (e) => {
      if (e.target.checked) {
        this.selectedRules.add(domain);
        item.classList.add('selected');
      } else {
        this.selectedRules.delete(domain);
        item.classList.remove('selected');
      }
      this.updateRulesToolbar();
    });

    // 編集中ならフォームを表示
    if (this.editingRuleDomain === domain) {
      item.appendChild(this.createRuleEditForm(domain, rule));
    }

    const editBtn = item.querySelector('.edit-btn');
    editBtn.addEventListener('click', () => {
      if (this.editingRuleDomain === domain) {
        this.editingRuleDomain = null;
      } else {
        this.editingRuleDomain = domain;
      }
      this.renderRulesList();
    });

    const deleteBtn = item.querySelector('.delete-btn');
    deleteBtn.addEventListener('click', () => this.runAction(() => this.deleteRule(domain)));

    return item;
  }

  createRuleEditForm(domain, rule) {
    const form = document.createElement('div');
    form.className = 'rule-edit-form';

    const currentTags = [...(rule.tags || [])];

    form.innerHTML = `
      <div class="rule-edit-row">
        <span class="rule-edit-label">アクション</span>
        <select class="rule-action-select">
          <option value="block"${rule.action === 'block' ? ' selected' : ''}>ブロック</option>
          <option value="allow"${rule.action === 'allow' ? ' selected' : ''}>許可</option>
        </select>
      </div>
      <div class="rule-edit-row">
        <span class="rule-edit-label">メモ</span>
        <input type="text" class="rule-memo-input" value="${this.escapeHtml(rule.memo || '')}" placeholder="メモを入力...">
      </div>
      <div class="rule-edit-row">
        <span class="rule-edit-label">タグ</span>
        <div class="rule-tags-editor">
          ${currentTags.map(t => `<span class="rule-tag-chip" data-tag="${this.escapeHtml(t)}">${this.escapeHtml(t)} <span class="tag-remove">&times;</span></span>`).join('')}
          <input type="text" class="rule-tag-input" placeholder="タグを入力または選択">
        </div>
      </div>
      <div class="rule-edit-buttons">
        <button class="rule-edit-btn cancel">キャンセル</button>
        <button class="rule-edit-btn save">保存</button>
      </div>
    `;

    // タグ削除
    form.querySelectorAll('.tag-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const chip = e.target.closest('.rule-tag-chip');
        const tag = chip.dataset.tag;
        const idx = currentTags.indexOf(tag);
        if (idx >= 0) currentTags.splice(idx, 1);
        chip.remove();
      });
    });

    // タグ追加（Enter & サジェスト共通）
    const tagInput = form.querySelector('.rule-tag-input');
    const addTagToForm = (value) => {
      if (value && !currentTags.includes(value)) {
        currentTags.push(value);
        const chip = document.createElement('span');
        chip.className = 'rule-tag-chip';
        chip.dataset.tag = value;
        chip.innerHTML = `${this.escapeHtml(value)} <span class="tag-remove">&times;</span>`;
        chip.querySelector('.tag-remove').addEventListener('click', () => {
          const idx = currentTags.indexOf(value);
          if (idx >= 0) currentTags.splice(idx, 1);
          chip.remove();
        });
        tagInput.before(chip);
      }
    };

    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addTagToForm(tagInput.value.trim());
        tagInput.value = '';
      }
    });

    this.setupTagSuggest(tagInput, currentTags, addTagToForm);

    // タグエディタクリックでフォーカス
    const tagsEditor = form.querySelector('.rule-tags-editor');
    tagsEditor.addEventListener('click', () => tagInput.focus());

    // キャンセル
    form.querySelector('.cancel').addEventListener('click', () => {
      this.editingRuleDomain = null;
      this.renderRulesList();
    });

    // 保存
    form.querySelector('.save').addEventListener('click', async () => {
      const newAction = form.querySelector('.rule-action-select').value;
      const newMemo = form.querySelector('.rule-memo-input').value.trim();

      // アクション変更
      if (newAction !== rule.action) {
        await this.request({
          type: 'SET_RULE_ACTION',
          domain,
          action: newAction
        });
      }

      // メタデータ更新
      const response = await this.request({
        type: 'UPDATE_RULE_META',
        domain,
        memo: newMemo,
        tags: currentTags
      });

      if (response.success) {
        this.domainRules = response.domain_rules;
      }

      this.editingRuleDomain = null;
      // データ再読み込みで全体を同期
      await this.loadData();
    });

    return form;
  }

  // ルール追加フォームを表示
  showAddRuleForm() {
    this.showingAddForm = !this.showingAddForm;
    this.renderRulesList();
  }

  createAddRuleFormElement() {
    const form = document.createElement('div');
    form.className = 'add-rule-form';

    const addTags = [];

    form.innerHTML = `
      <div class="rule-edit-row">
        <span class="rule-edit-label">ドメイン</span>
        <input type="text" class="add-rule-domain" placeholder="example.com">
      </div>
      <div class="rule-edit-row">
        <span class="rule-edit-label">アクション</span>
        <select class="rule-action-select">
          <option value="block">ブロック</option>
          <option value="allow">許可</option>
        </select>
      </div>
      <div class="rule-edit-row">
        <span class="rule-edit-label">メモ</span>
        <input type="text" class="rule-memo-input" placeholder="メモを入力...">
      </div>
      <div class="rule-edit-row">
        <span class="rule-edit-label">タグ</span>
        <div class="rule-tags-editor">
          <input type="text" class="rule-tag-input" placeholder="タグを入力または選択">
        </div>
      </div>
      <div class="rule-edit-buttons">
        <button class="rule-edit-btn cancel">キャンセル</button>
        <button class="rule-edit-btn save">追加</button>
      </div>
    `;

    const tagInput = form.querySelector('.rule-tag-input');
    const addTagToForm = (value) => {
      if (value && !addTags.includes(value)) {
        addTags.push(value);
        const chip = document.createElement('span');
        chip.className = 'rule-tag-chip';
        chip.dataset.tag = value;
        chip.innerHTML = `${this.escapeHtml(value)} <span class="tag-remove">&times;</span>`;
        chip.querySelector('.tag-remove').addEventListener('click', () => {
          const idx = addTags.indexOf(value);
          if (idx >= 0) addTags.splice(idx, 1);
          chip.remove();
        });
        tagInput.before(chip);
      }
    };

    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addTagToForm(tagInput.value.trim());
        tagInput.value = '';
      }
    });

    this.setupTagSuggest(tagInput, addTags, addTagToForm);

    const tagsEditor = form.querySelector('.rule-tags-editor');
    tagsEditor.addEventListener('click', () => tagInput.focus());

    form.querySelector('.cancel').addEventListener('click', () => {
      this.showingAddForm = false;
      this.renderRulesList();
    });

    form.querySelector('.save').addEventListener('click', async () => {
      const domainInput = form.querySelector('.add-rule-domain');
      const domain = normalizeDomain(domainInput.value);

      if (!domain) {
        this.showToast('有効なドメイン名を入力してください', 'error');
        domainInput.focus();
        return;
      }

      const action = form.querySelector('.rule-action-select').value;
      const memo = form.querySelector('.rule-memo-input').value.trim();

      const response = await this.request({
        type: 'ADD_RULE',
        domain,
        action,
        memo,
        tags: addTags
      });

      if (response.success) {
        this.domainData.blocked_domains = response.blocked_domains;
        this.domainData.allowed_domains = response.allowed_domains;
        this.domainRules = response.domain_rules;
        this.showingAddForm = false;
        this.render();
      }
    });

    return form;
  }

  insertAddRuleForm(rulesList, emptyState) {
    const form = this.createAddRuleFormElement();
    rulesList.insertBefore(form, emptyState);
  }

  // ルール削除
  async deleteRule(domain) {
    const confirmed = await this.confirmAction({
      title: 'ルールを削除',
      message: `「${domain}」のルールを削除します。`,
      confirmLabel: '削除'
    });
    if (!confirmed) return;

    const response = await this.request({
      type: 'DELETE_RULE',
      domain
    });

    if (response.success) {
      this.domainData.blocked_domains = response.blocked_domains;
      this.domainData.allowed_domains = response.allowed_domains;
      this.domainRules = response.domain_rules;
      this.render();
    }
  }

  // 全ルール削除
  async deleteAllRules() {
    const count = Object.keys(this.domainRules).length;
    if (count === 0) return;

    const confirmed = await this.confirmAction({
      title: 'すべてのルールを削除',
      message: `${count}件のルールを削除します。この操作は取り消せません。`,
      confirmLabel: 'すべて削除'
    });
    if (!confirmed) return;

    const response = await this.request({
      type: 'BULK_DELETE_RULES',
      domains: Object.keys(this.domainRules)
    });
    this.domainData.blocked_domains = response.blocked_domains;
    this.domainData.allowed_domains = response.allowed_domains;
    this.domainRules = response.domain_rules;
    this.render();
    this.showToast(`${count}件のルールを削除しました`);
  }

  // ルールツールバーを更新（通常/選択モード切り替え）
  updateRulesToolbar() {
    const toolbar = document.getElementById('rulesToolbar');
    const normalSection = toolbar.querySelector('.rules-toolbar-normal');
    const selectSection = toolbar.querySelector('.rules-toolbar-select');
    const selectedCount = document.getElementById('selectedCount');

    // 削除済みドメインを selectedRules から除外
    for (const domain of this.selectedRules) {
      if (!this.domainRules[domain]) {
        this.selectedRules.delete(domain);
      }
    }

    const rulesTotal = Object.keys(this.domainRules).length;
    const exportRulesBtn = document.getElementById('exportRulesBtn');
    exportRulesBtn.disabled = rulesTotal === 0;

    if (this.selectedRules.size > 0) {
      normalSection.style.display = 'none';
      selectSection.style.display = 'flex';
      toolbar.classList.add('select-mode');
      selectedCount.textContent = this.selectedRules.size;
    } else {
      normalSection.style.display = 'flex';
      selectSection.style.display = 'none';
      toolbar.classList.remove('select-mode');
    }
  }

  // 一括タグ付けダイアログ
  bulkTagRules() {
    if (this.selectedRules.size === 0) return;

    // 既存のダイアログがあれば削除
    const existing = document.querySelector('.bulk-tag-dialog-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'bulk-tag-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'bulk-tag-dialog';
    dialog.innerHTML = `
      <div class="bulk-tag-dialog-title">${this.selectedRules.size}件のドメインにタグを追加</div>
      <div class="bulk-tag-input-wrap">
        <input type="text" class="rule-tag-input" placeholder="タグを入力またはリストから選択">
      </div>
      <div class="bulk-tag-dialog-buttons">
        <button class="rule-edit-btn cancel">キャンセル</button>
        <button class="rule-edit-btn save">追加</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const tagInput = dialog.querySelector('.rule-tag-input');
    const inputWrap = dialog.querySelector('.bulk-tag-input-wrap');

    // サジェストドロップダウンを設定
    const dropdown = document.createElement('div');
    dropdown.className = 'tag-suggest-dropdown';
    inputWrap.style.position = 'relative';
    inputWrap.appendChild(dropdown);

    const updateSuggestions = () => {
      const query = tagInput.value.trim().toLowerCase();
      const existingTags = this.getAllExistingTags();
      const filtered = existingTags.filter(t => !query || t.toLowerCase().includes(query));

      if (filtered.length === 0) {
        dropdown.style.display = 'none';
        return;
      }

      dropdown.innerHTML = '';
      filtered.forEach(tag => {
        const item = document.createElement('div');
        item.className = 'tag-suggest-item';
        item.textContent = tag;
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          tagInput.value = tag;
          dropdown.style.display = 'none';
        });
        dropdown.appendChild(item);
      });
      dropdown.style.display = 'block';
    };

    tagInput.addEventListener('focus', updateSuggestions);
    tagInput.addEventListener('input', () => {
      updateSuggestions();
    });
    tagInput.addEventListener('blur', () => {
      setTimeout(() => { dropdown.style.display = 'none'; }, 150);
    });

    setTimeout(() => tagInput.focus(), 50);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    dialog.querySelector('.cancel').addEventListener('click', () => overlay.remove());

    dialog.querySelector('.save').addEventListener('click', async () => {
      const tagName = tagInput.value.trim();
      if (!tagName) return;

      const domains = Array.from(this.selectedRules);
      const response = await this.request({
        type: 'BULK_UPDATE_TAGS',
        domains,
        addTags: [tagName]
      });

      if (response.success) {
        this.domainRules = response.domain_rules;
        this.selectedRules.clear();
        this.render();
      }
      overlay.remove();
    });

    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        dialog.querySelector('.save').click();
      } else if (e.key === 'Escape') {
        overlay.remove();
      }
    });
  }

  // 一括削除
  async bulkDeleteRules() {
    if (this.selectedRules.size === 0) return;

    const confirmed = await this.confirmAction({
      title: '選択したルールを削除',
      message: `${this.selectedRules.size}件のルールを削除します。`,
      confirmLabel: '削除'
    });
    if (!confirmed) return;

    const domains = Array.from(this.selectedRules);
    const response = await this.request({
      type: 'BULK_DELETE_RULES',
      domains
    });

    if (response.success) {
      this.domainData.blocked_domains = response.blocked_domains;
      this.domainData.allowed_domains = response.allowed_domains;
      this.domainRules = response.domain_rules;
      this.selectedRules.clear();
      this.render();
    }
  }

  // エクスポート
  exportRules(selectedOnly) {
    const rules = this.domainRules;
    let exportData;

    if (selectedOnly && this.selectedRules.size > 0) {
      const selectedRulesObj = {};
      for (const domain of this.selectedRules) {
        if (rules[domain]) {
          selectedRulesObj[domain] = rules[domain];
        }
      }
      exportData = selectedRulesObj;
    } else {
      exportData = rules;
    }

    if (Object.keys(exportData).length === 0) {
      this.showToast('エクスポートするルールがありません', 'error');
      return;
    }

    const json = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      rules: exportData
    }, null, 2);

    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const date = new Date().toISOString().slice(0, 10);
    a.download = `domain-rules-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // インポート（ファイル選択をトリガー）
  importRules() {
    document.getElementById('importFileInput').click();
  }

  validateImportData(data) {
    if (!data || data.version !== 1 || !data.rules ||
        typeof data.rules !== 'object' || Array.isArray(data.rules)) {
      throw new Error('version: 1 と rules オブジェクトが必要です');
    }

    const entries = Object.entries(data.rules);
    if (entries.length === 0 || entries.length > MAX_IMPORT_RULES) {
      throw new Error(`ルール件数は1〜${MAX_IMPORT_RULES}件で指定してください`);
    }

    const rules = Object.create(null);
    for (const [rawDomain, rule] of entries) {
      const domain = normalizeDomain(rawDomain);
      if (!domain) throw new Error(`${rawDomain}: 無効なドメインです`);
      if (!rule || (rule.action !== 'block' && rule.action !== 'allow')) {
        throw new Error(`${rawDomain}: action は block または allow で指定してください`);
      }
      if (rule.memo !== undefined && (typeof rule.memo !== 'string' || rule.memo.length > 500)) {
        throw new Error(`${rawDomain}: memo は500文字以内の文字列です`);
      }
      if (rule.tags !== undefined && (!Array.isArray(rule.tags) || rule.tags.length > 20 ||
          rule.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.trim().length > 32))) {
        throw new Error(`${rawDomain}: tags は1〜32文字の文字列を20件以内で指定してください`);
      }
      rules[domain] = {
        action: rule.action,
        memo: (rule.memo || '').trim(),
        tags: [...new Set((rule.tags || []).map(tag => tag.trim()))]
      };
    }
    return rules;
  }

  // インポートファイル処理
  async handleImportFile(file) {
    try {
      const text = await file.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        this.showToast('JSONの解析に失敗しました。ファイル形式を確認してください。', 'error');
        return;
      }

      const validatedRules = this.validateImportData(data);
      const importDomains = Object.keys(validatedRules);

      // 重複チェック
      const existingDomains = Object.keys(this.domainRules);
      const duplicates = importDomains.filter(d => existingDomains.includes(d));

      if (duplicates.length > 0) {
        const confirmed = await this.confirmAction({
          title: '既存ルールを上書き',
          message: `${importDomains.length}件中${duplicates.length}件が登録済みです。既存のメモとタグを上書きします。`,
          confirmLabel: '上書き',
          danger: false
        });
        if (!confirmed) return;
      }

      // IMPORT_RULES でバックグラウンドに送信
      const response = await this.request({
        type: 'IMPORT_RULES',
        rules: validatedRules
      });

      if (response.success) {
        this.domainData.blocked_domains = response.blocked_domains;
        this.domainData.allowed_domains = response.allowed_domains;
        this.domainRules = response.domain_rules;
        this.render();
        this.showToast(`${importDomains.length}件のルールを読み込みました`);
      }
    } catch (error) {
      if (!error.reportedToUser) {
        this.showToast('インポートに失敗しました: ' + error.message, 'error');
      }
    }
  }

  // 選択解除
  clearSelection() {
    this.selectedRules.clear();
    this.renderRulesList();
    this.updateRulesToolbar();
  }
}

// 初期化
document.addEventListener('DOMContentLoaded', () => {
  new DomainTrafficInspector();
});
