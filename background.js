// Domain Traffic Inspector - Background Service Worker

// タブごとのデータを管理
const tabData = new Map();

// グローバルな除外ドメインリスト（全タブ共通）
let ignoredDomains = new Set();

// 許可ドメインリスト（厳格モード用）
let allowedDomains = new Set();

// 動的ルールのIDカウンター（Service Worker再起動対策）
let ruleIdCounter = 1000;

// 厳格モードのブロックルールID（固定）
const STRICT_MODE_BLOCK_RULE_ID = 1;

// 現在のモード（'normal' or 'strict'）
let currentMode = 'normal';

// ブロック機能の有効/無効（グローバル）
let blockingEnabled = true;

// 初期化完了フラグ
let initialized = false;

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
    const result = await chrome.storage.local.get(['ignoredDomains', 'allowedDomains', 'currentMode', 'blockingEnabled']);
    if (result.ignoredDomains) {
      ignoredDomains = new Set(result.ignoredDomains);
    }
    if (result.allowedDomains) {
      allowedDomains = new Set(result.allowedDomains);
    }
    if (result.currentMode) {
      currentMode = result.currentMode;
    }
    if (result.blockingEnabled !== undefined) {
      blockingEnabled = result.blockingEnabled;
    }

    // アイコンバッジを更新
    updateIconBadge();

    initialized = true;
  } catch (error) {
    console.error('Initialization error:', error);
  }
}

// 除外ドメインをストレージに保存
async function saveIgnoredDomains() {
  await chrome.storage.local.set({
    ignoredDomains: Array.from(ignoredDomains)
  });
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

  // ストレージから保存されているブロックドメインを復元
  const result = await chrome.storage.local.get(['blockedDomainsBackup']);
  if (result.blockedDomainsBackup && result.blockedDomainsBackup.length > 0) {
    for (const domain of result.blockedDomainsBackup) {
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
  // 現在のブロックドメインをバックアップ
  const blockedDomains = await getBlockedDomains();
  await chrome.storage.local.set({ blockedDomainsBackup: blockedDomains });

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
          resourceTypes: [
            'main_frame', 'sub_frame', 'stylesheet', 'script',
            'image', 'font', 'object', 'xmlhttprequest', 'ping',
            'media', 'websocket', 'other'
          ],
          excludedRequestDomains: Array.from(allowedDomains)
        }
      }]
    });
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
          resourceTypes: [
            'main_frame', 'sub_frame', 'stylesheet', 'script',
            'image', 'font', 'object', 'xmlhttprequest', 'ping',
            'media', 'websocket', 'other'
          ],
          excludedRequestDomains: Array.from(allowedDomains)
        }
      }]
    });
  } catch (error) {
    console.error('Failed to update strict mode rule:', error);
  }
}

// 初期化を実行
initialize();

// URLからドメインを抽出
function extractDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return null;
  }
}

// 複合TLD（2段階のTLD）
const COMPOUND_TLDS = [
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'ed.jp', 'gr.jp',
  'co.uk', 'org.uk', 'me.uk', 'ac.uk',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'net.nz', 'org.nz',
  'co.kr', 'or.kr', 'ne.kr',
  'com.br', 'net.br', 'org.br',
  'com.cn', 'net.cn', 'org.cn'
];

// ドメインからルートドメインを抽出
function extractRootDomain(domain) {
  const parts = domain.split('.');
  if (parts.length <= 2) return domain;

  // 複合TLDチェック
  const lastTwo = parts.slice(-2).join('.');
  if (COMPOUND_TLDS.includes(lastTwo)) {
    return parts.slice(-3).join('.');
  }

  return parts.slice(-2).join('.');
}

// ドメインリストを統合（サブドメインをルートドメインにまとめる）
function consolidateDomains(domains) {
  // ルートドメインでグループ化
  const groups = new Map();

  domains.forEach(domain => {
    const root = extractRootDomain(domain);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root).push(domain);
  });

  // 結果を構築
  const consolidated = [];
  const removed = [];

  groups.forEach((subdomains, root) => {
    if (subdomains.length >= 2) {
      // 2つ以上のサブドメインがある場合はルートドメインに統合
      consolidated.push(root);
      // 元のサブドメインを削除リストに追加（ルート自体は除く）
      subdomains.forEach(d => {
        if (d !== root) removed.push(d);
      });
    } else {
      // 1つだけならそのまま
      consolidated.push(subdomains[0]);
    }
  });

  return { consolidated, removed };
}

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

// リソースタイプを短縮形に変換
function getShortType(type) {
  const typeMap = {
    'script': 'JS',
    'stylesheet': 'CSS',
    'image': 'IMG',
    'xmlhttprequest': 'XHR',
    'font': 'FONT',
    'media': 'MEDIA',
    'sub_frame': 'FRAME',
    'main_frame': 'DOC',
    'ping': 'PING',
    'websocket': 'WS',
    'other': 'OTHER'
  };
  return typeMap[type] || 'OTHER';
}

// リクエスト監視
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { tabId, url, type } = details;
    if (tabId < 0) return; // バックグラウンドリクエストは除外

    const domain = extractDomain(url);
    if (!domain) return;

    // 除外ドメインはカウントしない
    if (ignoredDomains.has(domain)) return;

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

    // サイドパネルに更新を通知（非同期でブロックドメインを取得）
    (async () => {
      const blockedDomains = await getBlockedDomains();
      chrome.runtime.sendMessage({
        type: 'UPDATE_COUNTS',
        tabId,
        data: {
          domain_counts: data.domain_counts,
          main_domain: data.main_domain,
          blocked_domains: blockedDomains,
          ignored_domains: Array.from(ignoredDomains),
          mode: currentMode,
          allowed_domains: Array.from(allowedDomains),
          blocking_enabled: blockingEnabled
        }
      }).catch(() => {
        // サイドパネルが開いていない場合は無視
      });
    })();
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
          resourceTypes: [
            'main_frame', 'sub_frame', 'stylesheet', 'script',
            'image', 'font', 'object', 'xmlhttprequest', 'ping',
            'media', 'websocket', 'other'
          ]
        }
      }]
    });
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
    console.log(`Unblocked domain: ${domain}, ruleId: ${ruleToRemove.id}`);
  } catch (error) {
    console.error('Failed to unblock domain:', error);
  }
}

// ドメインを除外リストに追加
async function ignoreDomain(domain) {
  ignoredDomains.add(domain);
  await saveIgnoredDomains();

  // 全タブのカウントからこのドメインを削除
  tabData.forEach((data) => {
    delete data.domain_counts[domain];
  });
}

// ドメインを除外リストから削除
async function unignoreDomain(domain) {
  ignoredDomains.delete(domain);
  await saveIgnoredDomains();
}

// 現在のブロック状態を取得（Chrome APIから直接取得）
async function getBlockedDomains() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const domains = [];
  rules.forEach(rule => {
    if (rule.condition.requestDomains) {
      domains.push(...rule.condition.requestDomains);
    }
  });
  return domains;
}

// メッセージハンドラ
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ブロック機能の状態を取得
  if (message.type === 'GET_BLOCKING_STATE') {
    (async () => {
      await initialize();
      sendResponse({
        blocking_enabled: blockingEnabled,
        mode: currentMode
      });
    })();
    return true;
  }

  // ブロック機能を有効化
  if (message.type === 'ENABLE_BLOCKING') {
    (async () => {
      await initialize();
      await enableBlocking();
      sendResponse({
        success: true,
        blocking_enabled: blockingEnabled
      });
    })();
    return true;
  }

  // ブロック機能を無効化
  if (message.type === 'DISABLE_BLOCKING') {
    (async () => {
      await initialize();
      await disableBlocking();
      sendResponse({
        success: true,
        blocking_enabled: blockingEnabled
      });
    })();
    return true;
  }

  if (message.type === 'GET_TAB_DATA') {
    const { tabId } = message;
    (async () => {
      await initialize();
      const data = tabData.get(tabId);
      const blockedDomains = await getBlockedDomains();
      sendResponse({
        domain_counts: data?.domain_counts || {},
        main_domain: data?.main_domain || null,
        blocked_domains: blockedDomains,
        ignored_domains: Array.from(ignoredDomains),
        mode: currentMode,
        allowed_domains: Array.from(allowedDomains),
        blocking_enabled: blockingEnabled
      });
    })();
    return true;
  }

  if (message.type === 'BLOCK_DOMAIN') {
    const { domain } = message;
    (async () => {
      await blockDomain(domain);
      const blockedDomains = await getBlockedDomains();
      sendResponse({ success: true, blocked_domains: blockedDomains });
    })();
    return true;
  }

  if (message.type === 'UNBLOCK_DOMAIN') {
    const { domain } = message;
    (async () => {
      await unblockDomain(domain);
      const blockedDomains = await getBlockedDomains();
      sendResponse({ success: true, blocked_domains: blockedDomains });
    })();
    return true;
  }

  if (message.type === 'IGNORE_DOMAIN') {
    const { domain } = message;
    (async () => {
      await initialize();
      await ignoreDomain(domain);
      sendResponse({ success: true, ignored_domains: Array.from(ignoredDomains) });
    })();
    return true;
  }

  if (message.type === 'UNIGNORE_DOMAIN') {
    const { domain } = message;
    (async () => {
      await initialize();
      await unignoreDomain(domain);
      sendResponse({ success: true, ignored_domains: Array.from(ignoredDomains) });
    })();
    return true;
  }

  if (message.type === 'CLEAR_COUNTS') {
    const { tabId } = message;
    const data = tabData.get(tabId);
    if (data) {
      data.domain_counts = {};
    }
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'GET_IGNORED_DOMAINS') {
    (async () => {
      await initialize();
      sendResponse({ ignored_domains: Array.from(ignoredDomains) });
    })();
    return true;
  }

  // 一括スルー
  if (message.type === 'BULK_IGNORE') {
    const { domains } = message;
    (async () => {
      await initialize();
      for (const domain of domains) {
        await ignoreDomain(domain);
      }
      sendResponse({ success: true, ignored_domains: Array.from(ignoredDomains) });
    })();
    return true;
  }

  // 一括ブロック
  if (message.type === 'BULK_BLOCK') {
    const { domains } = message;
    (async () => {
      await initialize();
      for (const domain of domains) {
        await blockDomain(domain);
      }
      const blockedDomains = await getBlockedDomains();
      sendResponse({ success: true, blocked_domains: blockedDomains });
    })();
    return true;
  }

  // 一括ブロック解除
  if (message.type === 'BULK_UNBLOCK') {
    const { domains } = message;
    (async () => {
      await initialize();
      for (const domain of domains) {
        await unblockDomain(domain);
      }
      const blockedDomains = await getBlockedDomains();
      sendResponse({ success: true, blocked_domains: blockedDomains });
    })();
    return true;
  }

  // 一括スルー解除
  if (message.type === 'BULK_UNIGNORE') {
    const { domains } = message;
    (async () => {
      await initialize();
      for (const domain of domains) {
        await unignoreDomain(domain);
      }
      sendResponse({ success: true, ignored_domains: Array.from(ignoredDomains) });
    })();
    return true;
  }

  // モード取得
  if (message.type === 'GET_MODE') {
    (async () => {
      await initialize();
      sendResponse({
        mode: currentMode,
        allowed_domains: Array.from(allowedDomains)
      });
    })();
    return true;
  }

  // モード設定
  if (message.type === 'SET_MODE') {
    const { mode, mainDomain } = message;
    (async () => {
      await initialize();
      if (mode === 'strict') {
        await enableStrictMode(mainDomain);
      } else {
        await disableStrictMode();
      }
      sendResponse({
        success: true,
        mode: currentMode,
        allowed_domains: Array.from(allowedDomains)
      });
    })();
    return true;
  }

  // ドメイン許可（厳格モード用）
  if (message.type === 'ALLOW_DOMAIN') {
    const { domain } = message;
    (async () => {
      await initialize();
      await allowDomain(domain);
      sendResponse({
        success: true,
        allowed_domains: Array.from(allowedDomains)
      });
    })();
    return true;
  }

  // ドメイン許可解除（厳格モード用）
  if (message.type === 'DISALLOW_DOMAIN') {
    const { domain } = message;
    (async () => {
      await initialize();
      await disallowDomain(domain);
      sendResponse({
        success: true,
        allowed_domains: Array.from(allowedDomains)
      });
    })();
    return true;
  }

  // 許可ドメイン一覧取得
  if (message.type === 'GET_ALLOWED_DOMAINS') {
    (async () => {
      await initialize();
      sendResponse({ allowed_domains: Array.from(allowedDomains) });
    })();
    return true;
  }

  // 許可ドメインを統合
  if (message.type === 'CONSOLIDATE_ALLOWED_DOMAINS') {
    (async () => {
      await initialize();
      const { consolidated, removed } = consolidateDomains(Array.from(allowedDomains));

      // 許可リストを更新
      allowedDomains = new Set(consolidated);
      await saveAllowedDomains();

      // 厳格モードのルールを更新
      if (currentMode === 'strict') {
        await updateStrictModeRule();
      }

      sendResponse({
        success: true,
        allowed_domains: Array.from(allowedDomains),
        removed_count: removed.length,
        removed_domains: removed
      });
    })();
    return true;
  }

  // 許可ドメインを編集（置き換え）
  if (message.type === 'EDIT_ALLOWED_DOMAIN') {
    const { oldDomain, newDomain } = message;
    (async () => {
      await initialize();

      // 古いドメインを削除、新しいドメインを追加
      allowedDomains.delete(oldDomain);
      allowedDomains.add(newDomain);
      await saveAllowedDomains();

      // 厳格モードのルールを更新
      if (currentMode === 'strict') {
        await updateStrictModeRule();
      }

      sendResponse({
        success: true,
        allowed_domains: Array.from(allowedDomains)
      });
    })();
    return true;
  }

  // ブロックドメインを編集（置き換え）
  if (message.type === 'EDIT_BLOCKED_DOMAIN') {
    const { oldDomain, newDomain } = message;
    (async () => {
      await initialize();

      // 古いルールを削除
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      const oldRule = rules.find(r =>
        r.id !== STRICT_MODE_BLOCK_RULE_ID &&
        r.condition.requestDomains &&
        r.condition.requestDomains.includes(oldDomain)
      );

      const removeIds = oldRule ? [oldRule.id] : [];

      // 新しいルールを追加（既存でなければ）
      const existingNew = rules.find(r =>
        r.id !== STRICT_MODE_BLOCK_RULE_ID &&
        r.condition.requestDomains &&
        r.condition.requestDomains.includes(newDomain)
      );

      const addRules = [];
      if (!existingNew) {
        addRules.push({
          id: ruleIdCounter++,
          priority: 2,
          action: { type: 'block' },
          condition: {
            requestDomains: [newDomain],
            resourceTypes: [
              'main_frame', 'sub_frame', 'stylesheet', 'script',
              'image', 'font', 'object', 'xmlhttprequest', 'ping',
              'media', 'websocket', 'other'
            ]
          }
        });
      }

      if (removeIds.length > 0 || addRules.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: removeIds,
          addRules: addRules
        });
      }

      const blockedDomains = await getBlockedDomains();
      sendResponse({
        success: true,
        blocked_domains: blockedDomains
      });
    })();
    return true;
  }

  // ブロックドメインを統合
  if (message.type === 'CONSOLIDATE_BLOCKED_DOMAINS') {
    (async () => {
      await initialize();
      const blockedDomains = await getBlockedDomains();
      const { consolidated, removed } = consolidateDomains(blockedDomains);

      // 統合されて不要になったルールを削除
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      const removeIds = [];

      removed.forEach(domain => {
        const rule = rules.find(r =>
          r.id !== STRICT_MODE_BLOCK_RULE_ID &&
          r.condition.requestDomains &&
          r.condition.requestDomains.includes(domain)
        );
        if (rule) removeIds.push(rule.id);
      });

      // 新しいルートドメインを追加（まだない場合）
      const addRules = [];
      for (const domain of consolidated) {
        const exists = rules.some(r =>
          r.id !== STRICT_MODE_BLOCK_RULE_ID &&
          r.condition.requestDomains &&
          r.condition.requestDomains.includes(domain)
        );
        if (!exists && removed.some(d => extractRootDomain(d) === domain)) {
          addRules.push({
            id: ruleIdCounter++,
            priority: 2,
            action: { type: 'block' },
            condition: {
              requestDomains: [domain],
              resourceTypes: [
                'main_frame', 'sub_frame', 'stylesheet', 'script',
                'image', 'font', 'object', 'xmlhttprequest', 'ping',
                'media', 'websocket', 'other'
              ]
            }
          });
        }
      }

      if (removeIds.length > 0 || addRules.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: removeIds,
          addRules: addRules
        });
      }

      const newBlockedDomains = await getBlockedDomains();
      sendResponse({
        success: true,
        blocked_domains: newBlockedDomains,
        removed_count: removed.length,
        removed_domains: removed
      });
    })();
    return true;
  }
});

// 拡張機能アイコンクリックでサイドパネルを開く
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// サイドパネルの動作設定
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
