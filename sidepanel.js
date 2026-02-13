// Domain Traffic Inspector - Side Panel Logic

// 広告・トラッキング判定用キーワード
const AD_KEYWORDS = [
  'ad', 'ads', 'adserver', 'adservice', 'adsystem',
  'track', 'tracker', 'tracking',
  'analytics', 'stats', 'metrics', 'telemetry',
  'beacon', 'pixel', 'pxl',
  'bid', 'bidder', 'rtb', 'ssp', 'dsp',
  'sync', 'match', 'cookie',
  'doubleclick', 'googlesyndication', 'googleadservices',
  'facebook.*pixel', 'fbevents',
  'criteo', 'pubmatic', 'rubiconproject', 'openx',
  'taboola', 'outbrain', 'mgid',
  'amazon-adsystem', 'moatads',
  'scorecardresearch', 'quantserve', 'omtrdc',
  'adnxs', 'adsrvr', 'adform', 'adroll',
  'mopub', 'inmobi', 'appsflyer', 'adjust', 'branch',
  'microad', 'i-mobile', 'imobile', 'fam-8', 'bance'
];

// 安全なドメイン判定用キーワード
const SAFE_KEYWORDS = [
  'fonts.googleapis', 'fonts.gstatic',
  'ajax.googleapis', 'cdn.jsdelivr', 'cdnjs.cloudflare',
  'unpkg.com', 'stackpath',
  'jquery', 'bootstrap', 'fontawesome'
];

class DomainTrafficInspector {
  constructor() {
    this.currentTabId = null;
    this.domainData = {
      domain_counts: {},
      main_domain: null,
      blocked_domains: [],
      mode: 'normal',
      allowed_domains: [],
      blocking_enabled: true,
      domain_rules: {}
    };
    this.domainRules = {};
    this.expandedTags = new Set();
    this.sortBy = 'count';
    this.searchQuery = '';
    this.activeTab = 'traffic';
    this.trafficFilter = 'all';
    this.editingRuleDomain = null;
    this.showingAddForm = false;

    this.init();
  }

  // HTMLエスケープ
  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ドメインが広告/トラッキングの可能性があるか判定
  isLikelyAd(domain) {
    const lowerDomain = domain.toLowerCase();
    return AD_KEYWORDS.some(keyword => lowerDomain.includes(keyword));
  }

  // ドメインが安全（CDN等）か判定
  isLikelySafe(domain) {
    const lowerDomain = domain.toLowerCase();
    return SAFE_KEYWORDS.some(keyword => lowerDomain.includes(keyword));
  }

  // サードパーティか判定
  isThirdParty(domain) {
    if (!this.domainData.main_domain) return false;
    const mainDomain = this.domainData.main_domain;
    if (domain === mainDomain) return false;
    if (domain.endsWith('.' + mainDomain) || mainDomain.endsWith('.' + domain)) return false;
    const getDomainRoot = (d) => {
      const parts = d.split('.');
      return parts.length >= 2 ? parts.slice(-2).join('.') : d;
    };
    return getDomainRoot(domain) !== getDomainRoot(mainDomain);
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
    }
  }

  bindEvents() {
    // 検索入力
    const searchInput = document.getElementById('searchInput');
    searchInput.addEventListener('input', (e) => {
      this.searchQuery = e.target.value.toLowerCase();
      this.render();
    });

    // クリアボタン
    const clearBtn = document.getElementById('clearBtn');
    clearBtn.addEventListener('click', () => this.clearCounts());

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
        btn.classList.add('active');
        this.activeTab = btn.dataset.tab;
        this.updateTabPanels();
      });
    });

    // タブ切り替え監視
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
      this.currentTabId = activeInfo.tabId;
      await this.loadData();
    });

    // 一括ブロックボタン
    const bulkBlockBtn = document.getElementById('bulkBlockBtn');
    bulkBlockBtn.addEventListener('click', () => this.bulkBlock());

    // モードトグル
    const modeToggle = document.getElementById('modeToggle');
    modeToggle.addEventListener('change', () => this.toggleMode());

    // ブロック機能ON/OFFスイッチ
    const blockingSwitch = document.getElementById('blockingSwitch');
    blockingSwitch.addEventListener('change', () => this.toggleBlocking());

    // ルールタブ: 追加ボタン
    const addRuleBtn = document.getElementById('addRuleBtn');
    addRuleBtn.addEventListener('click', () => this.showAddRuleForm());

    // ルールタブ: 全削除ボタン
    const deleteAllRulesBtn = document.getElementById('deleteAllRulesBtn');
    deleteAllRulesBtn.addEventListener('click', () => this.deleteAllRules());
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
        this.domainData = message.data;
        this.domainRules = message.data.domain_rules || {};
        this.render(oldCounts);
      }
    });
  }

  async loadData() {
    if (!this.currentTabId) return;

    try {
      const response = await chrome.runtime.sendMessage({
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
    if (!this.currentTabId) return;

    await chrome.runtime.sendMessage({
      type: 'CLEAR_COUNTS',
      tabId: this.currentTabId
    });

    this.domainData.domain_counts = {};
    this.render();
  }

  async toggleBlock(domain) {
    const isBlocked = this.domainData.blocked_domains.includes(domain);
    const messageType = isBlocked ? 'UNBLOCK_DOMAIN' : 'BLOCK_DOMAIN';

    const response = await chrome.runtime.sendMessage({
      type: messageType,
      domain
    });

    if (response.success) {
      this.domainData.blocked_domains = response.blocked_domains;
      this.domainRules = response.domain_rules || this.domainRules;
      this.render();
    }
  }

  // 表示中のドメインをすべてブロック
  async bulkBlock() {
    const visibleDomains = this.getSortedDomains().map(([domain]) => domain);
    if (visibleDomains.length === 0) return;

    const confirmed = confirm(`${visibleDomains.length}件のドメインをすべてブロックしますか？`);
    if (!confirmed) return;

    const response = await chrome.runtime.sendMessage({
      type: 'BULK_BLOCK',
      domains: visibleDomains
    });

    if (response.success) {
      this.domainData.blocked_domains = response.blocked_domains;
      this.domainRules = response.domain_rules || this.domainRules;
      this.render();
    }
  }

  // モード切り替え
  async toggleMode() {
    const modeToggle = document.getElementById('modeToggle');
    const newMode = modeToggle.checked ? 'strict' : 'normal';

    const response = await chrome.runtime.sendMessage({
      type: 'SET_MODE',
      mode: newMode,
      mainDomain: this.domainData.main_domain
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

    const response = await chrome.runtime.sendMessage({
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
    const container = document.querySelector('.container');

    blockingSwitch.checked = enabled;
    blockingLabel.textContent = enabled ? 'ON' : 'OFF';
    blockingLabel.classList.toggle('off', !enabled);
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
      modeDescription.textContent = 'ホワイトリスト方式：許可したドメインのみ通信可能';
      normalLabel.classList.remove('active');
      strictLabel.classList.add('active');
      container.classList.add('strict-mode');
    } else {
      modeDescription.textContent = 'ブラックリスト方式：選択したドメインをブロック';
      normalLabel.classList.add('active');
      strictLabel.classList.remove('active');
      container.classList.remove('strict-mode');
    }
  }

  // ドメインを許可（厳格モード用）
  async allowDomain(domain) {
    const response = await chrome.runtime.sendMessage({
      type: 'ALLOW_DOMAIN',
      domain
    });

    if (response.success) {
      this.domainData.allowed_domains = response.allowed_domains;
      this.domainRules = response.domain_rules || this.domainRules;
      this.render();
    }
  }

  // ドメインの許可を解除（厳格モード用）
  async disallowDomain(domain) {
    const response = await chrome.runtime.sendMessage({
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
    const { domain_counts, blocked_domains, allowed_domains, mode } = this.domainData;
    let domains = Object.entries(domain_counts);

    // ブロック済みドメインを除外
    domains = domains.filter(([domain]) =>
      !blocked_domains.includes(domain)
    );

    // トラフィックフィルタ
    if (this.trafficFilter === 'passing') {
      if (mode === 'strict') {
        domains = domains.filter(([domain]) =>
          allowed_domains?.includes(domain)
        );
      }
    } else if (this.trafficFilter === 'blocked') {
      if (mode === 'strict') {
        domains = domains.filter(([domain]) =>
          !allowed_domains?.includes(domain)
        );
      } else {
        domains = [];
      }
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
    if (this.searchQuery) {
      domains = domains.filter(([domain]) =>
        domain.toLowerCase().includes(this.searchQuery)
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
    this.renderTrafficList(oldCounts);
    this.renderRulesList();
    this.updateStats();
    this.updateBulkActions();
    this.updateTabCounts();
  }

  updateTabCounts() {
    const rulesCount = Object.keys(this.domainRules).length;
    const rulesTabCount = document.getElementById('rulesTabCount');
    rulesTabCount.textContent = rulesCount;
    rulesTabCount.dataset.count = rulesCount;
  }

  updateBulkActions() {
    const sortedDomains = this.getSortedDomains();
    const visibleCount = sortedDomains.length;

    document.getElementById('visibleCount').textContent = visibleCount;

    const bulkBlockBtn = document.getElementById('bulkBlockBtn');
    bulkBlockBtn.disabled = visibleCount === 0;

    if (this.searchQuery) {
      bulkBlockBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
        </svg>
        絞込みをブロック
      `;
    } else {
      bulkBlockBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
        </svg>
        すべてブロック
      `;
    }
  }

  updateStats() {
    const totalDomains = Object.keys(this.domainData.domain_counts).length;
    const totalRequests = Object.values(this.domainData.domain_counts).reduce((acc, data) => {
      const count = typeof data === 'object' ? data.total : data;
      return acc + count;
    }, 0);

    document.getElementById('totalDomains').textContent = totalDomains;
    document.getElementById('totalRequests').textContent = totalRequests;
  }

  // リソースタイプのバッジを生成
  renderTypeBadges(types) {
    if (!types || Object.keys(types).length === 0) return '';

    const typeOrder = ['JS', 'XHR', 'IMG', 'CSS', 'FONT', 'FRAME', 'MEDIA', 'DOC', 'PING', 'WS', 'OTHER'];
    const typeColors = {
      'JS': '#f59e0b',
      'XHR': '#ef4444',
      'IMG': '#22c55e',
      'CSS': '#3b82f6',
      'FONT': '#8b5cf6',
      'FRAME': '#ec4899',
      'MEDIA': '#06b6d4',
      'DOC': '#6b7280',
      'PING': '#ef4444',
      'WS': '#f59e0b',
      'OTHER': '#6b7280'
    };

    return typeOrder
      .filter(type => types[type])
      .map(type => `<span class="type-badge" style="background: ${typeColors[type]}20; color: ${typeColors[type]}">${type}:${types[type]}</span>`)
      .join('');
  }

  renderTrafficList(oldCounts = {}) {
    const domainList = document.getElementById('domainList');
    const emptyState = document.getElementById('emptyState');
    const sortedDomains = this.getSortedDomains();

    if (sortedDomains.length === 0) {
      emptyState.style.display = 'flex';
      const items = domainList.querySelectorAll('.domain-item');
      items.forEach(item => item.remove());
      return;
    }

    emptyState.style.display = 'none';

    const isStrictMode = this.domainData.mode === 'strict';

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
      const isAllowed = this.domainData.allowed_domains?.includes(domain);
      const isAd = this.isLikelyAd(domain);
      const isSafe = this.isLikelySafe(domain);
      const isThirdParty = this.isThirdParty(domain);

      const count = typeof data === 'object' ? data.total : data;
      const types = typeof data === 'object' ? data.types : null;
      const oldCount = oldCounts[domain] ? (typeof oldCounts[domain] === 'object' ? oldCounts[domain].total : oldCounts[domain]) : undefined;
      const wasUpdated = oldCount !== undefined && oldCount !== count;

      let item = existingElements.get(domain);
      let isNewItem = false;

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

        let itemClass = 'domain-item';
        if (isStrictMode) {
          if (isAllowed) {
            itemClass += ' allowed';
          } else {
            itemClass += ' blocked';
          }
        }
        if (isAd) {
          itemClass += ' likely-ad';
        }
        item.className = itemClass;
      } else {
        item = this.createDomainItem(domain, data, isStrictMode, isAllowed, isAd, isSafe, isThirdParty, wasUpdated);
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

  createDomainItem(domain, data, isStrictMode, isAllowed, isAd, isSafe, isThirdParty, wasUpdated) {
    const count = typeof data === 'object' ? data.total : data;
    const types = typeof data === 'object' ? data.types : null;

    let tags = '';
    if (isAd) {
      tags += '<span class="domain-tag tag-ad" title="広告/トラッキングの可能性">広告</span>';
    }
    if (isSafe) {
      tags += '<span class="domain-tag tag-safe" title="CDN/ライブラリ">安全</span>';
    }
    if (isThirdParty) {
      tags += '<span class="domain-tag tag-3p" title="サードパーティ">3rd</span>';
    }

    const item = document.createElement('div');
    item.dataset.domain = domain;
    item.dataset.new = 'true';
    setTimeout(() => delete item.dataset.new, 200);

    let itemClass = 'domain-item';
    if (isStrictMode) {
      if (isAllowed) {
        itemClass += ' allowed';
      } else {
        itemClass += ' blocked';
      }
    }
    if (isAd) {
      itemClass += ' likely-ad';
    }

    item.className = itemClass;

    let actionButtons = '';

    if (isStrictMode) {
      actionButtons = `
        <button class="allow-btn${isAllowed ? ' active' : ''}" title="${isAllowed ? '許可を解除' : '許可する'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            ${isAllowed
              ? '<path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M9 12l2 2 4-4"/>'
              : '<circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/>'
            }
          </svg>
        </button>
        <button class="block-btn" title="ブロック">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
          </svg>
        </button>
      `;
    } else {
      actionButtons = `
        <button class="block-btn" title="ブロック">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
          </svg>
        </button>
      `;
    }

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
      blockBtn.addEventListener('click', () => this.toggleBlock(domain));
    }

    const allowBtn = item.querySelector('.allow-btn');
    if (allowBtn) {
      allowBtn.addEventListener('click', () => {
        if (this.domainData.allowed_domains?.includes(domain)) {
          this.disallowDomain(domain);
        } else {
          this.allowDomain(domain);
        }
      });
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
    if (this.searchQuery) {
      filtered = ruleEntries.filter(([domain, rule]) =>
        domain.toLowerCase().includes(this.searchQuery) ||
        (rule.memo && rule.memo.toLowerCase().includes(this.searchQuery)) ||
        (rule.tags && rule.tags.some(t => t.toLowerCase().includes(this.searchQuery)))
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

    // 既存をクリアして再描画
    rulesList.querySelectorAll('.rules-group, .add-rule-form').forEach(el => el.remove());
    rulesList.insertBefore(fragment, emptyState);
  }

  createRulesGroup(tag, items) {
    const group = document.createElement('div');
    group.className = 'rules-group';
    if (this.expandedTags.has(tag)) {
      group.classList.add('expanded');
    }

    const header = document.createElement('div');
    header.className = 'rules-group-header';
    header.innerHTML = `
      <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
      <span class="rules-group-title">${this.escapeHtml(tag)}</span>
      <span class="rules-group-count">${items.length}</span>
    `;

    header.addEventListener('click', () => {
      if (this.expandedTags.has(tag)) {
        this.expandedTags.delete(tag);
      } else {
        this.expandedTags.add(tag);
      }
      group.classList.toggle('expanded');
    });

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

    const tagsHtml = (rule.tags || [])
      .map(t => `<span class="rule-tag-chip">${this.escapeHtml(t)}</span>`)
      .join('');

    const memoHtml = rule.memo
      ? `<span class="rule-item-memo" title="${this.escapeHtml(rule.memo)}">${this.escapeHtml(rule.memo)}</span>`
      : '';

    item.innerHTML = `
      <div class="rule-item-row">
        <div class="rule-item-info">
          <div class="rule-item-domain" title="${this.escapeHtml(domain)}">${this.escapeHtml(domain)}</div>
          <div class="rule-item-meta">
            <span class="rule-action-badge ${rule.action}">${rule.action === 'block' ? 'ブロック' : '許可'}</span>
            ${memoHtml}
            <div class="rule-item-tags">${tagsHtml}</div>
          </div>
        </div>
        <div class="rule-item-actions">
          <button class="edit-btn" title="編集">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="delete-btn" title="削除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
          </button>
        </div>
      </div>
    `;

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
    deleteBtn.addEventListener('click', () => this.deleteRule(domain));

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
          <input type="text" class="rule-tag-input" placeholder="タグを入力してEnter">
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

    // タグ追加（Enter）
    const tagInput = form.querySelector('.rule-tag-input');
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const value = tagInput.value.trim();
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
        tagInput.value = '';
      }
    });

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
        await chrome.runtime.sendMessage({
          type: 'SET_RULE_ACTION',
          domain,
          action: newAction
        });
      }

      // メタデータ更新
      const response = await chrome.runtime.sendMessage({
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
          <input type="text" class="rule-tag-input" placeholder="タグを入力してEnter">
        </div>
      </div>
      <div class="rule-edit-buttons">
        <button class="rule-edit-btn cancel">キャンセル</button>
        <button class="rule-edit-btn save">追加</button>
      </div>
    `;

    const tagInput = form.querySelector('.rule-tag-input');
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const value = tagInput.value.trim();
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
        tagInput.value = '';
      }
    });

    const tagsEditor = form.querySelector('.rule-tags-editor');
    tagsEditor.addEventListener('click', () => tagInput.focus());

    form.querySelector('.cancel').addEventListener('click', () => {
      this.showingAddForm = false;
      this.renderRulesList();
    });

    form.querySelector('.save').addEventListener('click', async () => {
      const domainInput = form.querySelector('.add-rule-domain');
      const domain = domainInput.value.trim();

      if (!domain) {
        domainInput.focus();
        return;
      }

      // 簡易バリデーション
      if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$/.test(domain)) {
        alert('無効なドメイン形式です');
        return;
      }

      const action = form.querySelector('.rule-action-select').value;
      const memo = form.querySelector('.rule-memo-input').value.trim();

      const response = await chrome.runtime.sendMessage({
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
    const confirmed = confirm(`"${domain}" のルールを削除しますか？`);
    if (!confirmed) return;

    const response = await chrome.runtime.sendMessage({
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

    const confirmed = confirm(`${count}件のルールをすべて削除しますか？`);
    if (!confirmed) return;

    const domains = Object.keys(this.domainRules);
    for (const domain of domains) {
      await chrome.runtime.sendMessage({
        type: 'DELETE_RULE',
        domain
      });
    }

    await this.loadData();
  }
}

// 初期化
document.addEventListener('DOMContentLoaded', () => {
  new DomainTrafficInspector();
});
