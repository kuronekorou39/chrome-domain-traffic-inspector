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
      ignored_domains: [],
      mode: 'normal',
      allowed_domains: []
    };
    this.sortBy = 'count';
    this.searchQuery = '';
    this.activeTab = 'traffic';

    this.init();
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
    // メインドメインと一致、またはサブドメインならファーストパーティ
    const mainDomain = this.domainData.main_domain;
    if (domain === mainDomain) return false;
    // サブドメインチェック（例：www.example.com と example.com）
    if (domain.endsWith('.' + mainDomain) || mainDomain.endsWith('.' + domain)) return false;
    // ルートドメイン比較（例：sub.example.com と example.com）
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

    // ソートボタン
    const sortBtns = document.querySelectorAll('.sort-btn');
    sortBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        sortBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.sortBy = btn.dataset.sort;
        this.render();
      });
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

    // 一括スルーボタン
    const bulkIgnoreBtn = document.getElementById('bulkIgnoreBtn');
    bulkIgnoreBtn.addEventListener('click', () => this.bulkIgnore());

    // 一括ブロックボタン
    const bulkBlockBtn = document.getElementById('bulkBlockBtn');
    bulkBlockBtn.addEventListener('click', () => this.bulkBlock());

    // 一括ブロック解除ボタン
    const bulkUnblockBtn = document.getElementById('bulkUnblockBtn');
    bulkUnblockBtn.addEventListener('click', () => this.bulkUnblock());

    // 一括スルー解除ボタン
    const bulkUnignoreBtn = document.getElementById('bulkUnignoreBtn');
    bulkUnignoreBtn.addEventListener('click', () => this.bulkUnignore());

    // モードトグル
    const modeToggle = document.getElementById('modeToggle');
    modeToggle.addEventListener('change', () => this.toggleMode());

    // 一括許可解除ボタン（厳格モード用）
    const bulkDisallowBtn = document.getElementById('bulkDisallowBtn');
    bulkDisallowBtn.addEventListener('click', () => this.bulkDisallow());
  }

  updateTabPanels() {
    const panels = document.querySelectorAll('.tab-panel');
    panels.forEach(panel => panel.classList.remove('active'));

    if (this.activeTab === 'traffic') {
      document.getElementById('trafficPanel').classList.add('active');
    } else if (this.activeTab === 'blocked') {
      document.getElementById('blockedPanel').classList.add('active');
    } else if (this.activeTab === 'allowed') {
      document.getElementById('allowedPanel').classList.add('active');
    } else {
      document.getElementById('ignoredPanel').classList.add('active');
    }
  }

  startListening() {
    // バックグラウンドからの更新を受信
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'UPDATE_COUNTS' && message.tabId === this.currentTabId) {
        const oldCounts = { ...this.domainData.domain_counts };
        this.domainData = message.data;
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
      this.render();
    }
  }

  async ignoreDomain(domain) {
    const response = await chrome.runtime.sendMessage({
      type: 'IGNORE_DOMAIN',
      domain
    });

    if (response.success) {
      this.domainData.ignored_domains = response.ignored_domains;
      // カウントからも削除
      delete this.domainData.domain_counts[domain];
      this.render();
    }
  }

  async unignoreDomain(domain) {
    const response = await chrome.runtime.sendMessage({
      type: 'UNIGNORE_DOMAIN',
      domain
    });

    if (response.success) {
      this.domainData.ignored_domains = response.ignored_domains;
      this.render();
    }
  }

  // 表示中のドメインをすべてスルー
  async bulkIgnore() {
    const visibleDomains = this.getSortedDomains().map(([domain]) => domain);
    if (visibleDomains.length === 0) return;

    const confirmed = confirm(`${visibleDomains.length}件のドメインをすべてスルーしますか？`);
    if (!confirmed) return;

    const response = await chrome.runtime.sendMessage({
      type: 'BULK_IGNORE',
      domains: visibleDomains
    });

    if (response.success) {
      this.domainData.ignored_domains = response.ignored_domains;
      // カウントからも削除
      visibleDomains.forEach(domain => {
        delete this.domainData.domain_counts[domain];
      });
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
      this.render();
    }
  }

  // ブロック中のドメインをすべて解除
  async bulkUnblock() {
    const blockedDomains = this.domainData.blocked_domains || [];
    if (blockedDomains.length === 0) return;

    const confirmed = confirm(`${blockedDomains.length}件のブロックをすべて解除しますか？`);
    if (!confirmed) return;

    const response = await chrome.runtime.sendMessage({
      type: 'BULK_UNBLOCK',
      domains: blockedDomains
    });

    if (response.success) {
      this.domainData.blocked_domains = response.blocked_domains;
      this.render();
    }
  }

  // スルー中のドメインをすべて解除
  async bulkUnignore() {
    const ignoredDomains = this.domainData.ignored_domains || [];
    if (ignoredDomains.length === 0) return;

    const confirmed = confirm(`${ignoredDomains.length}件のスルーをすべて解除しますか？`);
    if (!confirmed) return;

    const response = await chrome.runtime.sendMessage({
      type: 'BULK_UNIGNORE',
      domains: ignoredDomains
    });

    if (response.success) {
      this.domainData.ignored_domains = response.ignored_domains;
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
      this.updateModeUI();
      this.render();
    }
  }

  // モードUIを更新
  updateModeUI() {
    const mode = this.domainData.mode;
    const modeToggle = document.getElementById('modeToggle');
    const modeDescription = document.getElementById('modeDescription');
    const normalLabel = document.getElementById('normalModeLabel');
    const strictLabel = document.getElementById('strictModeLabel');
    const allowedTab = document.getElementById('allowedTab');
    const container = document.querySelector('.container');

    modeToggle.checked = mode === 'strict';

    if (mode === 'strict') {
      modeDescription.textContent = 'ホワイトリスト方式：許可したドメインのみ通信可能';
      normalLabel.classList.remove('active');
      strictLabel.classList.add('active');
      allowedTab.style.display = '';
      container.classList.add('strict-mode');
    } else {
      modeDescription.textContent = 'ブラックリスト方式：選択したドメインをブロック';
      normalLabel.classList.add('active');
      strictLabel.classList.remove('active');
      allowedTab.style.display = 'none';
      container.classList.remove('strict-mode');
      // 厳格モードタブが選択されていた場合はトラフィックタブに戻す
      if (this.activeTab === 'allowed') {
        this.activeTab = 'traffic';
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('[data-tab="traffic"]').classList.add('active');
        this.updateTabPanels();
      }
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
      this.render();
    }
  }

  // 許可中のドメインをすべて解除
  async bulkDisallow() {
    const allowedDomains = this.domainData.allowed_domains || [];
    if (allowedDomains.length === 0) return;

    const confirmed = confirm(`${allowedDomains.length}件の許可をすべて解除しますか？\n（メインドメインも含まれます）`);
    if (!confirmed) return;

    for (const domain of allowedDomains) {
      await chrome.runtime.sendMessage({
        type: 'DISALLOW_DOMAIN',
        domain
      });
    }

    const response = await chrome.runtime.sendMessage({
      type: 'GET_ALLOWED_DOMAINS'
    });

    this.domainData.allowed_domains = response.allowed_domains;
    this.render();
  }

  getSortedDomains() {
    const { domain_counts } = this.domainData;
    let domains = Object.entries(domain_counts);

    // フィルタリング
    if (this.searchQuery) {
      domains = domains.filter(([domain]) =>
        domain.toLowerCase().includes(this.searchQuery)
      );
    }

    // ソート（新しいデータ構造に対応）
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
    this.updateModeUI();
    this.renderTrafficList(oldCounts);
    this.renderBlockedList();
    this.renderIgnoredList();
    this.renderAllowedList();
    this.updateStats();
    this.updateBulkActions();
  }

  updateBulkActions() {
    const sortedDomains = this.getSortedDomains();
    const visibleCount = sortedDomains.length;

    // 表示件数を更新
    document.getElementById('visibleCount').textContent = visibleCount;

    // ボタンの有効/無効状態を更新
    const bulkIgnoreBtn = document.getElementById('bulkIgnoreBtn');
    const bulkBlockBtn = document.getElementById('bulkBlockBtn');

    bulkIgnoreBtn.disabled = visibleCount === 0;
    bulkBlockBtn.disabled = visibleCount === 0;

    // 検索中かどうかでテキストを変更
    if (this.searchQuery) {
      bulkIgnoreBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
          <line x1="1" y1="1" x2="23" y2="23"/>
        </svg>
        絞込みをスルー
      `;
      bulkBlockBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
        </svg>
        絞込みをブロック
      `;
    } else {
      bulkIgnoreBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
          <line x1="1" y1="1" x2="23" y2="23"/>
        </svg>
        すべてスルー
      `;
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
    const blockedCount = this.domainData.blocked_domains.length;
    const ignoredCount = this.domainData.ignored_domains.length;
    const allowedCount = this.domainData.allowed_domains?.length || 0;

    document.getElementById('totalDomains').textContent = totalDomains;
    document.getElementById('totalRequests').textContent = totalRequests;
    document.getElementById('ignoredCount').textContent = ignoredCount;

    // 厳格モードでは「許可」カウントを表示
    const blockedCountEl = document.getElementById('blockedCount');
    const blockedLabelEl = blockedCountEl.nextElementSibling;
    if (this.domainData.mode === 'strict') {
      blockedCountEl.textContent = allowedCount;
      blockedLabelEl.textContent = '許可';
    } else {
      blockedCountEl.textContent = blockedCount;
      blockedLabelEl.textContent = 'ブロック';
    }
  }

  // リソースタイプのバッジを生成
  renderTypeBadges(types) {
    if (!types || Object.keys(types).length === 0) return '';

    const typeOrder = ['JS', 'XHR', 'IMG', 'CSS', 'FONT', 'FRAME', 'MEDIA', 'DOC', 'PING', 'WS', 'OTHER'];
    const typeColors = {
      'JS': '#f59e0b',    // オレンジ（スクリプト = 注意）
      'XHR': '#ef4444',   // 赤（通信 = 注意）
      'IMG': '#22c55e',   // 緑
      'CSS': '#3b82f6',   // 青
      'FONT': '#8b5cf6',  // 紫
      'FRAME': '#ec4899', // ピンク
      'MEDIA': '#06b6d4', // シアン
      'DOC': '#6b7280',   // グレー
      'PING': '#ef4444',  // 赤（トラッキング）
      'WS': '#f59e0b',    // オレンジ
      'OTHER': '#6b7280'  // グレー
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

    // 空状態の表示切替
    if (sortedDomains.length === 0) {
      emptyState.style.display = 'flex';
      const items = domainList.querySelectorAll('.domain-item');
      items.forEach(item => item.remove());
      return;
    }

    emptyState.style.display = 'none';

    // ドメインリストを構築
    const fragment = document.createDocumentFragment();

    const isStrictMode = this.domainData.mode === 'strict';

    sortedDomains.forEach(([domain, data]) => {
      const isBlocked = this.domainData.blocked_domains.includes(domain);
      const isAllowed = this.domainData.allowed_domains?.includes(domain);
      const isAd = this.isLikelyAd(domain);
      const isSafe = this.isLikelySafe(domain);
      const isThirdParty = this.isThirdParty(domain);

      // 新旧データ構造に対応
      const count = typeof data === 'object' ? data.total : data;
      const types = typeof data === 'object' ? data.types : null;
      const oldCount = oldCounts[domain] ? (typeof oldCounts[domain] === 'object' ? oldCounts[domain].total : oldCounts[domain]) : undefined;
      const wasUpdated = oldCount !== undefined && oldCount !== count;

      // タグを構築
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

      // 厳格モードでは許可されていないドメインをブロック扱いに見せる
      let itemClass = 'domain-item';
      if (isStrictMode) {
        if (isAllowed) {
          itemClass += ' allowed';
        } else {
          itemClass += ' blocked';
        }
      } else {
        if (isBlocked) {
          itemClass += ' blocked';
        }
      }
      if (isAd) {
        itemClass += ' likely-ad';
      }

      item.className = itemClass;

      // 厳格モード用のボタン
      let actionButton;
      if (isStrictMode) {
        actionButton = `
          <button class="allow-btn${isAllowed ? ' active' : ''}" title="${isAllowed ? '許可を解除' : '許可する'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${isAllowed
                ? '<path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M9 12l2 2 4-4"/>'
                : '<circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/>'
              }
            </svg>
          </button>
        `;
      } else {
        actionButton = `
          <button class="block-btn${isBlocked ? ' active' : ''}" title="${isBlocked ? 'ブロック解除' : 'ブロック'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${isBlocked
                ? '<path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M9 12l2 2 4-4"/>'
                : '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'
              }
            </svg>
          </button>
        `;
      }

      item.innerHTML = `
        <div class="domain-info">
          <div class="domain-header">
            <div class="domain-name" title="${domain}">${domain}</div>
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
          <button class="ignore-btn" title="スルー（監視対象から除外）">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
              <line x1="1" y1="1" x2="23" y2="23"/>
            </svg>
          </button>
          ${actionButton}
        </div>
      `;

      // イベント
      const ignoreBtn = item.querySelector('.ignore-btn');
      ignoreBtn.addEventListener('click', () => this.ignoreDomain(domain));

      if (isStrictMode) {
        const allowBtn = item.querySelector('.allow-btn');
        allowBtn.addEventListener('click', () => {
          if (isAllowed) {
            this.disallowDomain(domain);
          } else {
            this.allowDomain(domain);
          }
        });
      } else {
        const blockBtn = item.querySelector('.block-btn');
        blockBtn.addEventListener('click', () => this.toggleBlock(domain));
      }

      fragment.appendChild(item);
    });

    // 既存のアイテムを削除して新しいものを追加
    const existingItems = domainList.querySelectorAll('.domain-item');
    existingItems.forEach(item => item.remove());
    domainList.appendChild(fragment);
  }

  renderBlockedList() {
    const blockedList = document.getElementById('blockedList');
    const emptyState = document.getElementById('blockedEmptyState');
    const blockedDomains = this.domainData.blocked_domains || [];

    // フィルタリング
    let filteredDomains = blockedDomains;
    if (this.searchQuery) {
      filteredDomains = blockedDomains.filter(domain =>
        domain.toLowerCase().includes(this.searchQuery)
      );
    }

    // 件数表示を更新
    document.getElementById('blockedListCount').textContent = filteredDomains.length;

    // 一括解除ボタンの状態
    const bulkUnblockBtn = document.getElementById('bulkUnblockBtn');
    bulkUnblockBtn.disabled = blockedDomains.length === 0;

    // 空状態の表示切替
    if (filteredDomains.length === 0) {
      emptyState.style.display = 'flex';
      const items = blockedList.querySelectorAll('.domain-item');
      items.forEach(item => item.remove());
      return;
    }

    emptyState.style.display = 'none';

    // リストを構築
    const fragment = document.createDocumentFragment();

    filteredDomains.forEach(domain => {
      const item = document.createElement('div');
      item.className = 'domain-item blocked';
      item.innerHTML = `
        <div class="domain-info">
          <div class="domain-name" title="${domain}">${domain}</div>
          <div class="domain-meta">
            <span class="request-count" style="color: var(--danger);">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
              </svg>
              ブロック中
            </span>
          </div>
        </div>
        <button class="restore-btn" title="ブロック解除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
        </button>
      `;

      const restoreBtn = item.querySelector('.restore-btn');
      restoreBtn.addEventListener('click', () => this.toggleBlock(domain));

      fragment.appendChild(item);
    });

    // 既存のアイテムを削除して新しいものを追加
    const existingItems = blockedList.querySelectorAll('.domain-item');
    existingItems.forEach(item => item.remove());
    blockedList.appendChild(fragment);
  }

  renderIgnoredList() {
    const ignoredList = document.getElementById('ignoredList');
    const emptyState = document.getElementById('ignoredEmptyState');
    const ignoredDomains = this.domainData.ignored_domains || [];

    // フィルタリング
    let filteredDomains = ignoredDomains;
    if (this.searchQuery) {
      filteredDomains = ignoredDomains.filter(domain =>
        domain.toLowerCase().includes(this.searchQuery)
      );
    }

    // 件数表示を更新
    document.getElementById('ignoredListCount').textContent = filteredDomains.length;

    // 一括解除ボタンの状態
    const bulkUnignoreBtn = document.getElementById('bulkUnignoreBtn');
    bulkUnignoreBtn.disabled = ignoredDomains.length === 0;

    // 空状態の表示切替
    if (filteredDomains.length === 0) {
      emptyState.style.display = 'flex';
      const items = ignoredList.querySelectorAll('.domain-item');
      items.forEach(item => item.remove());
      return;
    }

    emptyState.style.display = 'none';

    // リストを構築
    const fragment = document.createDocumentFragment();

    filteredDomains.forEach(domain => {
      const item = document.createElement('div');
      item.className = 'domain-item ignored';
      item.innerHTML = `
        <div class="domain-info">
          <div class="domain-name" title="${domain}">${domain}</div>
          <div class="domain-meta">
            <span class="request-count" style="color: var(--warning);">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
              スルー中
            </span>
          </div>
        </div>
        <button class="restore-btn" title="監視を再開">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
      `;

      const restoreBtn = item.querySelector('.restore-btn');
      restoreBtn.addEventListener('click', () => this.unignoreDomain(domain));

      fragment.appendChild(item);
    });

    // 既存のアイテムを削除して新しいものを追加
    const existingItems = ignoredList.querySelectorAll('.domain-item');
    existingItems.forEach(item => item.remove());
    ignoredList.appendChild(fragment);
  }

  renderAllowedList() {
    const allowedList = document.getElementById('allowedList');
    const emptyState = document.getElementById('allowedEmptyState');
    const allowedDomains = this.domainData.allowed_domains || [];

    // フィルタリング
    let filteredDomains = allowedDomains;
    if (this.searchQuery) {
      filteredDomains = allowedDomains.filter(domain =>
        domain.toLowerCase().includes(this.searchQuery)
      );
    }

    // 件数表示を更新
    document.getElementById('allowedListCount').textContent = filteredDomains.length;

    // 一括解除ボタンの状態
    const bulkDisallowBtn = document.getElementById('bulkDisallowBtn');
    bulkDisallowBtn.disabled = allowedDomains.length === 0;

    // 空状態の表示切替
    if (filteredDomains.length === 0) {
      emptyState.style.display = 'flex';
      const items = allowedList.querySelectorAll('.domain-item');
      items.forEach(item => item.remove());
      return;
    }

    emptyState.style.display = 'none';

    // リストを構築
    const fragment = document.createDocumentFragment();

    filteredDomains.forEach(domain => {
      const isMain = domain === this.domainData.main_domain;
      const item = document.createElement('div');
      item.className = 'domain-item allowed';
      item.innerHTML = `
        <div class="domain-info">
          <div class="domain-header">
            <div class="domain-name" title="${domain}">${domain}</div>
            ${isMain ? '<span class="domain-tag tag-main">メイン</span>' : ''}
          </div>
          <div class="domain-meta">
            <span class="request-count" style="color: var(--success);">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
                <path d="M9 12l2 2 4-4"/>
              </svg>
              許可中
            </span>
          </div>
        </div>
        <button class="restore-btn disallow-btn" title="許可を解除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
          </svg>
        </button>
      `;

      const restoreBtn = item.querySelector('.restore-btn');
      restoreBtn.addEventListener('click', () => this.disallowDomain(domain));

      fragment.appendChild(item);
    });

    // 既存のアイテムを削除して新しいものを追加
    const existingItems = allowedList.querySelectorAll('.domain-item');
    existingItems.forEach(item => item.remove());
    allowedList.appendChild(fragment);
  }
}

// 初期化
document.addEventListener('DOMContentLoaded', () => {
  new DomainTrafficInspector();
});
