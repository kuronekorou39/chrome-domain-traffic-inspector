// Domain Traffic Inspector - Background Service Worker
importScripts('lib/domain-utils.js');

// タブごとのデータを管理
const tabData = new Map();

// 許可ドメインリスト（厳格モード用）
let allowedDomains = new Set();

// ドメインルール（メタデータ層）
let domainRules = {};

// 動的ルールのIDカウンター（Service Worker再起動対策）
let ruleIdCounter = 1000;

// 厳格モードのブロックルールID（固定）
const STRICT_MODE_BLOCK_RULE_ID = 1;

// 監視対象リソースタイプ（共通定数）
const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script',
  'image', 'font', 'object', 'xmlhttprequest', 'ping',
  'media', 'websocket', 'other'
];

// 現在のモード（'normal' or 'strict'）
let currentMode = 'normal';

// ブロック機能の有効/無効（グローバル）
let blockingEnabled = true;

// 初期化完了フラグ
let initialized = false;

// ブロックドメインのキャッシュ（毎リクエストでAPI呼出しを避ける）
let blockedDomainsCache = null;

// domainRulesの変更フラグ（変更時のみUPDATE_COUNTSに含める）
let domainRulesDirty = true;

// UPDATE_COUNTSスロットリング用
const pendingUpdates = new Map(); // tabId -> scheduled flag
const UPDATE_THROTTLE_MS = 500;

// domainRulesをストレージから読み込み
async function loadDomainRules() {
  const result = await chrome.storage.local.get(['domainRules']);
  domainRules = result.domainRules || {};
}

// domainRulesをストレージに保存
async function saveDomainRules() {
  domainRulesDirty = true;
  await chrome.storage.local.set({ domainRules });
}

// 初期化時に既存のルールを確認し、ルールIDカウンターを設定
async function initialize() {
  if (initialized) return;

  try {
    // 既存の動的ルールを取得してカウンターを設定
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    if (rules.length > 0) {
      const maxId = Math.max(...rules.map(r => r.id));
      ruleIdCounter = Math.max(ruleIdCounter, maxId + 1);
    }
    console.log(`Initialized with ${rules.length} existing rules, next ruleId: ${ruleIdCounter}`);

    // ストレージから設定を読み込み
    const result = await chrome.storage.local.get(['allowedDomains', 'currentMode', 'blockingEnabled']);
    if (result.allowedDomains) {
      allowedDomains = new Set(result.allowedDomains);
    }
    if (result.currentMode) {
      currentMode = result.currentMode;
    }
    if (result.blockingEnabled !== undefined) {
      blockingEnabled = result.blockingEnabled;
    }

    // domainRulesを読み込み
    await loadDomainRules();

    // マイグレーション（初回のみ）
    const migResult = await chrome.storage.local.get(['migrationDone']);
    if (!migResult.migrationDone) {
      await migrateToRules(rules);
      await chrome.storage.local.set({ migrationDone: true });
    }

    // アイコンバッジを更新
    updateIconBadge();

    initialized = true;
  } catch (error) {
    console.error('Initialization error:', error);
  }
}

// 既存データをdomainRulesにマイグレーション
async function migrateToRules(existingRules) {
  let changed = false;

  // declarativeNetRequestの既存ブロックルール → action: "block"
  for (const rule of existingRules) {
    if (rule.id === STRICT_MODE_BLOCK_RULE_ID) continue;
    if (rule.condition.requestDomains) {
      for (const domain of rule.condition.requestDomains) {
        if (!domainRules[domain]) {
          domainRules[domain] = { action: 'block', memo: '', tags: [] };
          changed = true;
        }
      }
    }
  }

  // allowedDomains → action: "allow"
  for (const domain of allowedDomains) {
    if (!domainRules[domain]) {
      domainRules[domain] = { action: 'allow', memo: '', tags: [] };
      changed = true;
    }
  }

  if (changed) {
    await saveDomainRules();
    console.log('Migration completed:', Object.keys(domainRules).length, 'rules');
  }
}

// 許可ドメインをストレージに保存
async function saveAllowedDomains() {
  await chrome.storage.local.set({
    allowedDomains: Array.from(allowedDomains)
  });
}

// モードをストレージに保存
async function saveCurrentMode() {
  await chrome.storage.local.set({ currentMode });
}

// ブロック有効状態をストレージに保存
async function saveBlockingEnabled() {
  await chrome.storage.local.set({ blockingEnabled });
}

// アイコンバッジを更新
function updateIconBadge() {
  if (blockingEnabled) {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' }); // 緑
  } else {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#6b7280' }); // グレー
  }
}

// ブロック機能を有効化
async function enableBlocking() {
  blockingEnabled = true;
  await saveBlockingEnabled();
  updateIconBadge();

  // domainRulesからブロックルールを復元
  for (const [domain, rule] of Object.entries(domainRules)) {
    if (rule.action === 'block') {
      await blockDomain(domain);
    }
  }

  // 厳格モードの場合はルールを再適用
  if (currentMode === 'strict') {
    await updateStrictModeRule();
  }
}

// ブロック機能を無効化（すべてのルールを一時的に削除）
async function disableBlocking() {
  blockingEnabled = false;
  await saveBlockingEnabled();
  updateIconBadge();

  // すべての動的ルールを削除
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const ruleIds = rules.map(r => r.id);
  if (ruleIds.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: ruleIds
    });
    invalidateBlockedDomainsCache();
  }
}

// 厳格モードを有効化
async function enableStrictMode(mainDomain) {
  currentMode = 'strict';
  await saveCurrentMode();

  // メインドメインを自動的に許可リストに追加
  if (mainDomain) {
    allowedDomains.add(mainDomain);
    await saveAllowedDomains();
    // domainRulesにも同期
    if (!domainRules[mainDomain]) {
      domainRules[mainDomain] = { action: 'allow', memo: '', tags: [] };
    } else {
      domainRules[mainDomain].action = 'allow';
    }
    await saveDomainRules();
  }

  // すべてのサードパーティをブロックするルールを追加
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [STRICT_MODE_BLOCK_RULE_ID],
      addRules: [{
        id: STRICT_MODE_BLOCK_RULE_ID,
        priority: 1,
        action: { type: 'block' },
        condition: {
          resourceTypes: ALL_RESOURCE_TYPES,
          excludedRequestDomains: Array.from(allowedDomains)
        }
      }]
    });
    invalidateBlockedDomainsCache();
    console.log('Strict mode enabled');
  } catch (error) {
    console.error('Failed to enable strict mode:', error);
  }
}

// 厳格モードを無効化
async function disableStrictMode() {
  currentMode = 'normal';
  await saveCurrentMode();

  // 厳格モードのブロックルールを削除
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [STRICT_MODE_BLOCK_RULE_ID]
    });
    invalidateBlockedDomainsCache();
    console.log('Strict mode disabled');
  } catch (error) {
    console.error('Failed to disable strict mode:', error);
  }
}

// 厳格モードでドメインを許可
async function allowDomain(domain) {
  allowedDomains.add(domain);
  await saveAllowedDomains();

  // ブロックリストから削除（相互排他）
  if (await isBlockedDomain(domain)) {
    await unblockDomain(domain);
  }

  // domainRulesに同期
  if (!domainRules[domain]) {
    domainRules[domain] = { action: 'allow', memo: '', tags: [] };
  } else {
    domainRules[domain].action = 'allow';
  }
  await saveDomainRules();

  // ルールを更新
  if (currentMode === 'strict') {
    await updateStrictModeRule();
  }
}

// ドメインがブロックされているか確認
async function isBlockedDomain(domain) {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return rules.some(r =>
    r.id !== STRICT_MODE_BLOCK_RULE_ID &&
    r.condition.requestDomains &&
    r.condition.requestDomains.includes(domain)
  );
}

// 厳格モードでドメインの許可を取り消し
async function disallowDomain(domain) {
  allowedDomains.delete(domain);
  await saveAllowedDomains();

  // ルールを更新
  if (currentMode === 'strict') {
    await updateStrictModeRule();
  }
}

// 厳格モードのルールを更新
async function updateStrictModeRule() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [STRICT_MODE_BLOCK_RULE_ID],
      addRules: [{
        id: STRICT_MODE_BLOCK_RULE_ID,
        priority: 1,
        action: { type: 'block' },
        condition: {
          resourceTypes: ALL_RESOURCE_TYPES,
          excludedRequestDomains: Array.from(allowedDomains)
        }
      }]
    });
    invalidateBlockedDomainsCache();
  } catch (error) {
    console.error('Failed to update strict mode rule:', error);
  }
}

// 初期化を実行
initialize();

// extractDomain, getShortType は lib/domain-utils.js から提供

// タブデータを初期化
function initTabData(tabId) {
  if (!tabData.has(tabId)) {
    tabData.set(tabId, {
      domain_counts: {},
      main_domain: null,
      blocked_domains: new Set()
    });
  }
  return tabData.get(tabId);
}


// スロットリングされたサイドパネル更新
function scheduleUpdate(tabId, data) {
  if (pendingUpdates.has(tabId)) return; // 既にスケジュール済み

  pendingUpdates.set(tabId, true);
  setTimeout(async () => {
    pendingUpdates.delete(tabId);
    try {
      const blockedDomains = await getBlockedDomains();
      const message = {
        type: 'UPDATE_COUNTS',
        tabId,
        data: {
          domain_counts: data.domain_counts,
          main_domain: data.main_domain,
          blocked_domains: blockedDomains,
          mode: currentMode,
          allowed_domains: Array.from(allowedDomains),
          blocking_enabled: blockingEnabled
        }
      };
      // domainRulesは変更時のみ含める
      if (domainRulesDirty) {
        message.data.domain_rules = domainRules;
        domainRulesDirty = false;
      }
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // サイドパネルが開いていない場合は無視
    }
  }, UPDATE_THROTTLE_MS);
}

// リクエスト監視
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { tabId, url, type } = details;
    if (tabId < 0) return; // バックグラウンドリクエストは除外

    const domain = extractDomain(url);
    if (!domain) return;

    const data = initTabData(tabId);
    const shortType = getShortType(type);

    // ドメインデータを初期化または更新
    if (!data.domain_counts[domain]) {
      data.domain_counts[domain] = {
        total: 0,
        types: {}
      };
    }

    data.domain_counts[domain].total += 1;
    data.domain_counts[domain].types[shortType] =
      (data.domain_counts[domain].types[shortType] || 0) + 1;

    // サイドパネルに更新を通知（スロットリング: 500ms間隔）
    scheduleUpdate(tabId, data);
  },
  { urls: ['<all_urls>'] }
);

// タブが閉じられたらデータをクリーンアップ
chrome.tabs.onRemoved.addListener((tabId) => {
  tabData.delete(tabId);
});

// タブがナビゲートしたらカウントをリセット＆メインドメインを記録
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    const data = initTabData(tabId);
    data.domain_counts = {};
    data.main_domain = extractDomain(changeInfo.url);
    // ブロックリストは維持
  }
});

// ドメインをブロック（全タブ対象）
async function blockDomain(domain) {
  await initialize();

  // 許可リストから削除（相互排他）
  if (allowedDomains.has(domain)) {
    allowedDomains.delete(domain);
    await saveAllowedDomains();
    // 厳格モードの場合はルールも更新
    if (currentMode === 'strict') {
      await updateStrictModeRule();
    }
  }

  // 既にブロック済みか確認
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const existingRule = existingRules.find(r =>
    r.id !== STRICT_MODE_BLOCK_RULE_ID &&
    r.condition.requestDomains && r.condition.requestDomains.includes(domain)
  );
  if (existingRule) {
    console.log(`Domain already blocked: ${domain}`);
    // domainRulesは同期しておく
    if (!domainRules[domain]) {
      domainRules[domain] = { action: 'block', memo: '', tags: [] };
      await saveDomainRules();
    } else if (domainRules[domain].action !== 'block') {
      domainRules[domain].action = 'block';
      await saveDomainRules();
    }
    return;
  }

  const ruleId = ruleIdCounter++;

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: ruleId,
        priority: 2,  // 厳格モードのルールより高い優先度
        action: { type: 'block' },
        condition: {
          requestDomains: [domain],
          resourceTypes: ALL_RESOURCE_TYPES
        }
      }]
    });
    invalidateBlockedDomainsCache();

    // domainRulesに同期
    if (!domainRules[domain]) {
      domainRules[domain] = { action: 'block', memo: '', tags: [] };
    } else {
      domainRules[domain].action = 'block';
    }
    await saveDomainRules();

    console.log(`Blocked domain: ${domain}, ruleId: ${ruleId}`);
  } catch (error) {
    console.error('Failed to block domain:', error);
  }
}

// ドメインのブロックを解除
async function unblockDomain(domain) {
  await initialize();

  try {
    // 現在のルールから該当ドメインのルールを探す
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const ruleToRemove = rules.find(r =>
      r.condition.requestDomains && r.condition.requestDomains.includes(domain)
    );

    if (!ruleToRemove) {
      console.log(`No rule found for domain: ${domain}`);
      return;
    }

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ruleToRemove.id]
    });
    invalidateBlockedDomainsCache();

    console.log(`Unblocked domain: ${domain}, ruleId: ${ruleToRemove.id}`);
  } catch (error) {
    console.error('Failed to unblock domain:', error);
  }
}

// ブロックドメインキャッシュを無効化
function invalidateBlockedDomainsCache() {
  blockedDomainsCache = null;
}

// 現在のブロック状態を取得（キャッシュ付き）
async function getBlockedDomains() {
  if (blockedDomainsCache !== null) return blockedDomainsCache;
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const domains = [];
  rules.forEach(rule => {
    if (rule.condition.requestDomains) {
      domains.push(...rule.condition.requestDomains);
    }
  });
  blockedDomainsCache = domains;
  return domains;
}

// 共通レスポンスヘルパー
async function fullStateResponse() {
  const blockedDomains = await getBlockedDomains();
  return {
    success: true,
    blocked_domains: blockedDomains,
    allowed_domains: Array.from(allowedDomains),
    domain_rules: domainRules
  };
}

// メッセージハンドラ（ディスパッチテーブル）
const messageHandlers = {
  GET_BLOCKING_STATE: async () => ({
    blocking_enabled: blockingEnabled,
    mode: currentMode
  }),

  ENABLE_BLOCKING: async () => {
    await enableBlocking();
    return { success: true, blocking_enabled: blockingEnabled };
  },

  DISABLE_BLOCKING: async () => {
    await disableBlocking();
    return { success: true, blocking_enabled: blockingEnabled };
  },

  GET_TAB_DATA: async (msg) => {
    const data = tabData.get(msg.tabId);
    const blockedDomains = await getBlockedDomains();
    return {
      domain_counts: data?.domain_counts || {},
      main_domain: data?.main_domain || null,
      blocked_domains: blockedDomains,
      mode: currentMode,
      allowed_domains: Array.from(allowedDomains),
      blocking_enabled: blockingEnabled,
      domain_rules: domainRules
    };
  },

  BLOCK_DOMAIN: async (msg) => {
    await blockDomain(msg.domain);
    return fullStateResponse();
  },

  UNBLOCK_DOMAIN: async (msg) => {
    await unblockDomain(msg.domain);
    // メタデータ（メモ・タグ）がないルールは削除、あるものは保持
    const rule = domainRules[msg.domain];
    if (rule && !rule.memo && (!rule.tags || rule.tags.length === 0)) {
      delete domainRules[msg.domain];
      await saveDomainRules();
    }
    return fullStateResponse();
  },

  CLEAR_COUNTS: (msg) => {
    const data = tabData.get(msg.tabId);
    if (data) data.domain_counts = {};
    return { success: true };
  },

  BULK_BLOCK: async (msg) => {
    for (const domain of msg.domains) {
      await blockDomain(domain);
    }
    return fullStateResponse();
  },

  GET_MODE: async () => ({
    mode: currentMode,
    allowed_domains: Array.from(allowedDomains)
  }),

  SET_MODE: async (msg) => {
    if (msg.mode === 'strict') {
      await enableStrictMode(msg.mainDomain);
    } else {
      await disableStrictMode();
    }
    return {
      success: true,
      mode: currentMode,
      allowed_domains: Array.from(allowedDomains),
      domain_rules: domainRules
    };
  },

  ALLOW_DOMAIN: async (msg) => {
    await allowDomain(msg.domain);
    return { success: true, allowed_domains: Array.from(allowedDomains), domain_rules: domainRules };
  },

  DISALLOW_DOMAIN: async (msg) => {
    await disallowDomain(msg.domain);
    return { success: true, allowed_domains: Array.from(allowedDomains), domain_rules: domainRules };
  },

  GET_ALLOWED_DOMAINS: async () => ({
    allowed_domains: Array.from(allowedDomains)
  }),

  GET_DOMAIN_RULES: async () => ({
    domain_rules: domainRules
  }),

  UPDATE_RULE_META: async (msg) => {
    if (!domainRules[msg.domain]) {
      return { success: false, error: 'Rule not found' };
    }
    if (msg.memo !== undefined) domainRules[msg.domain].memo = msg.memo;
    if (msg.tags !== undefined) domainRules[msg.domain].tags = msg.tags;
    await saveDomainRules();
    return { success: true, domain_rules: domainRules };
  },

  SET_RULE_ACTION: async (msg) => {
    if (msg.action === 'block') {
      await blockDomain(msg.domain);
    } else if (msg.action === 'allow') {
      if (await isBlockedDomain(msg.domain)) {
        await unblockDomain(msg.domain);
      }
      await allowDomain(msg.domain);
    }
    return fullStateResponse();
  },

  DELETE_RULE: async (msg) => {
    const rule = domainRules[msg.domain];
    if (rule) {
      if (rule.action === 'block') await unblockDomain(msg.domain);
      else if (rule.action === 'allow') await disallowDomain(msg.domain);
      delete domainRules[msg.domain];
      await saveDomainRules();
    }
    return fullStateResponse();
  },

  BULK_UPDATE_TAGS: async (msg) => {
    for (const domain of msg.domains) {
      if (domainRules[domain]) {
        const existing = domainRules[domain].tags || [];
        msg.addTags.forEach(tag => {
          if (!existing.includes(tag)) existing.push(tag);
        });
        domainRules[domain].tags = existing;
      }
    }
    await saveDomainRules();
    return { success: true, domain_rules: domainRules };
  },

  IMPORT_RULES: async (msg) => {
    for (const [domain, rule] of Object.entries(msg.rules)) {
      if (rule.action === 'block') await blockDomain(domain);
      else if (rule.action === 'allow') await allowDomain(domain);
      if (domainRules[domain]) {
        if (rule.memo !== undefined) domainRules[domain].memo = rule.memo;
        if (rule.tags !== undefined) domainRules[domain].tags = rule.tags;
      }
    }
    await saveDomainRules();
    return fullStateResponse();
  },

  BULK_DELETE_RULES: async (msg) => {
    for (const domain of msg.domains) {
      const rule = domainRules[domain];
      if (rule) {
        if (rule.action === 'block') await unblockDomain(domain);
        else if (rule.action === 'allow') await disallowDomain(domain);
        delete domainRules[domain];
      }
    }
    await saveDomainRules();
    return fullStateResponse();
  },

  ADD_RULE: async (msg) => {
    if (msg.action === 'block') await blockDomain(msg.domain);
    else if (msg.action === 'allow') await allowDomain(msg.domain);
    if (domainRules[msg.domain]) {
      if (msg.memo !== undefined) domainRules[msg.domain].memo = msg.memo;
      if (msg.tags !== undefined) domainRules[msg.domain].tags = msg.tags;
      await saveDomainRules();
    }
    return fullStateResponse();
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = messageHandlers[message.type];
  if (!handler) return;

  // initialize()完了後にハンドラを実行
  initialize()
    .then(() => handler(message))
    .then(sendResponse)
    .catch(err => {
      console.error(`Handler error [${message.type}]:`, err);
      sendResponse({ success: false, error: err.message });
    });
  return true;
});

// 拡張機能アイコンクリックでサイドパネルを開く
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// サイドパネルの動作設定
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
