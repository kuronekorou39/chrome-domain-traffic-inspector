// Domain Traffic Inspector - Side Panel Logic

// 広告・トラッキング判定: ドメインパーツ（.区切り）単位で完全一致するキーワード
const AD_PART_KEYWORDS = new Set([
  'ad', 'ads', 'adserver', 'adservice', 'adsystem',
  'track', 'tracker', 'tracking',
  'analytics', 'stats', 'metrics', 'telemetry',
  'beacon', 'pixel', 'pxl',
  'bid', 'bidder', 'rtb', 'ssp', 'dsp',
  'sync', 'match', 'cookie'
]);

// 広告・トラッキング判定: ドメイン名に含まれていれば一致（部分一致で安全なもの）
const AD_DOMAIN_PATTERNS = [
  'doubleclick', 'googlesyndication', 'googleadservices',
  'fbevents', 'facebook.com/tr',
  'criteo', 'pubmatic', 'rubiconproject', 'openx',
  'taboola', 'outbrain', 'mgid',
  'amazon-adsystem', 'moatads',
  'scorecardresearch', 'quantserve', 'omtrdc',
  'adnxs', 'adsrvr', 'adform', 'adroll',
  'mopub', 'inmobi', 'appsflyer',
  'microad', 'i-mobile', 'imobile', 'fam-8', 'bance'
];

// ccTLD（国別コードTLD + 汎用サブTLD）
const CC_TLDS = new Set([
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.uk', 'org.uk', 'ac.uk',
  'co.kr', 'or.kr', 'co.in', 'co.id',
  'com.au', 'com.br', 'com.cn', 'com.tw', 'com.hk',
  'com.sg', 'com.mx', 'com.ar', 'co.za', 'co.nz'
]);

// ドメインの登録ドメイン部分を取得（ccTLD対応）
function getDomainRoot(domain) {
  const parts = domain.split('.');
  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join('.');
    if (CC_TLDS.has(lastTwo)) {
      return parts.length >= 3 ? parts.slice(-3).join('.') : domain;
    }
  }
  return parts.length >= 2 ? parts.slice(-2).join('.') : domain;
}

// 安全なドメイン判定用（部分一致）
const SAFE_KEYWORDS = [
  'fonts.googleapis', 'fonts.gstatic',
  'ajax.googleapis', 'cdn.jsdelivr', 'cdnjs.cloudflare',
  'unpkg.com', 'stackpath', 'cloudfront.net',
  'akamaihd.net', 'fastly.net',
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
    this.searchQueries = { traffic: '', rules: '' };
    this.activeTab = 'traffic';
    this.trafficFilter = 'all';
    this.editingRuleDomain = null;
    this.showingAddForm = false;
    this.selectedRules = new Set();

    this.init();
  }

  // HTMLエスケープ
  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
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

  // ドメインが広告/トラッキングの可能性があるか判定
  isLikelyAd(domain) {
    const lowerDomain = domain.toLowerCase();
    // ドメインパーツ（.区切り）で完全一致チェック
    const parts = lowerDomain.split('.');
    if (parts.some(part => AD_PART_KEYWORDS.has(part))) return true;
    // 既知の広告ドメインパターンの部分一致チェック
    return AD_DOMAIN_PATTERNS.some(pattern => lowerDomain.includes(pattern));
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
      this.searchQueries[this.activeTab] = e.target.value.toLowerCase();
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
        // タブ切替時に検索欄を復元
        searchInput.value = this.searchQueries[this.activeTab] || '';
        this.updateTabPanels();
        this.render();
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

    // ルールタブ: エクスポート/インポート
    document.getElementById('exportRulesBtn').addEventListener('click', () => this.exportRules(false));
    document.getElementById('importRulesBtn').addEventListener('click', () => this.importRules());
    document.getElementById('importFileInput').addEventListener('change', (e) => {
      if (e.target.files[0]) {
        this.handleImportFile(e.target.files[0]);
        e.target.value = '';
      }
    });

    // ルールタブ: 選択モードボタン
    document.getElementById('bulkTagBtn').addEventListener('click', () => this.bulkTagRules());
    document.getElementById('exportSelectedBtn').addEventListener('click', () => this.exportRules(true));
    document.getElementById('bulkDeleteBtn').addEventListener('click', () => this.bulkDeleteRules());
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

    // 厳格モードON時は警告
    if (newMode === 'strict') {
      const confirmed = confirm(
        '厳格モードに切り替えますか？\n\n' +
        '許可リストに含まれないすべてのドメインへの通信がブロックされます。' +
        'ページの表示が崩れる可能性があります。'
      );
      if (!confirmed) {
        modeToggle.checked = false;
        return;
      }
    }

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
      modeDescription.textContent = '許可したドメインのみ通信可能（ホワイトリスト方式）';
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
    const blockedSet = new Set(blocked_domains);
    let domains = Object.entries(domain_counts);

    // トラフィックフィルタ
    if (this.trafficFilter === 'passing') {
      if (mode === 'strict') {
        domains = domains.filter(([domain]) =>
          allowed_domains?.includes(domain)
        );
      } else {
        domains = domains.filter(([domain]) =>
          !blockedSet.has(domain)
        );
      }
    } else if (this.trafficFilter === 'blocked') {
      if (mode === 'strict') {
        domains = domains.filter(([domain]) =>
          !allowed_domains?.includes(domain)
        );
      } else {
        domains = domains.filter(([domain]) =>
          blockedSet.has(domain)
        );
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
    bulkBlockBtn.disabled = visibleCount === 0;

    if (this.searchQueries.traffic) {
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
    const sortedDomains = this._cachedSortedDomains || this.getSortedDomains();

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

    const blockedSet = new Set(this.domainData.blocked_domains);

    sortedDomains.forEach(([domain, data], index) => {
      const isAllowed = this.domainData.allowed_domains?.includes(domain);
      const isBlocked = blockedSet.has(domain);
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
        } else if (isBlocked) {
          itemClass += ' explicitly-blocked';
        }
        if (isAd) {
          itemClass += ' likely-ad';
        }
        item.className = itemClass;
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

    let tags = '';
    if (isBlocked && !isStrictMode) {
      tags += '<span class="domain-tag tag-blocked" title="ブロック中">停止</span>';
    }
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
    } else if (isBlocked) {
      itemClass += ' explicitly-blocked';
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
        <button class="block-btn${isBlocked ? ' active' : ''}" title="${isBlocked ? 'ブロック解除' : 'ブロック'}">
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
      <input type="checkbox" class="rules-group-checkbox" ${allChecked ? 'checked' : ''}>
      <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
      <span class="rules-group-title">${this.escapeHtml(tag)}</span>
      <span class="rules-group-count">${items.length}</span>
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

    header.addEventListener('click', (e) => {
      if (e.target.closest('.rules-group-checkbox')) return;
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
        <input type="checkbox" class="rule-item-checkbox" ${this.selectedRules.has(domain) ? 'checked' : ''}>
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
    let selectedTag = '';

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
          selectedTag = tag;
          dropdown.style.display = 'none';
        });
        dropdown.appendChild(item);
      });
      dropdown.style.display = 'block';
    };

    tagInput.addEventListener('focus', updateSuggestions);
    tagInput.addEventListener('input', () => {
      selectedTag = '';
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
      const response = await chrome.runtime.sendMessage({
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

    const confirmed = confirm(`${this.selectedRules.size}件のルールを削除しますか？`);
    if (!confirmed) return;

    const domains = Array.from(this.selectedRules);
    const response = await chrome.runtime.sendMessage({
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
      alert('エクスポートするルールがありません');
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

  // インポートファイル処理
  async handleImportFile(file) {
    try {
      const text = await file.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        alert('JSONの解析に失敗しました。ファイル形式を確認してください。');
        return;
      }

      // バリデーション
      if (!data.version || !data.rules || typeof data.rules !== 'object') {
        alert('無効なファイル形式です。version と rules プロパティが必要です。');
        return;
      }

      const importDomains = Object.keys(data.rules);
      if (importDomains.length === 0) {
        alert('インポートするルールがありません。');
        return;
      }

      // 重複チェック
      const existingDomains = Object.keys(this.domainRules);
      const duplicates = importDomains.filter(d => existingDomains.includes(d));

      if (duplicates.length > 0) {
        const confirmed = confirm(
          `${importDomains.length}件中${duplicates.length}件が既に登録済みです。上書きしますか？`
        );
        if (!confirmed) return;
      }

      // IMPORT_RULES でバックグラウンドに送信
      const response = await chrome.runtime.sendMessage({
        type: 'IMPORT_RULES',
        rules: data.rules
      });

      if (response.success) {
        this.domainData.blocked_domains = response.blocked_domains;
        this.domainData.allowed_domains = response.allowed_domains;
        this.domainRules = response.domain_rules;
        this.render();
      }
    } catch (error) {
      alert('インポート中にエラーが発生しました: ' + error.message);
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
