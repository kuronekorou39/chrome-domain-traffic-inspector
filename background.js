// Domain Traffic Inspector - Background Service Worker

// タブごとのデータを管理
const tabData = new Map();

// グローバルな除外ドメインリスト（全タブ共通）
let ignoredDomains = new Set();

// 動的ルールのIDカウンター（Service Worker再起動対策）
let ruleIdCounter = 1000;

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
      ruleIdCounter = maxId + 1;
    }
    console.log(`Initialized with ${rules.length} existing rules, next ruleId: ${ruleIdCounter}`);

    // 除外ドメインを読み込み
    const result = await chrome.storage.local.get('ignoredDomains');
    if (result.ignoredDomains) {
      ignoredDomains = new Set(result.ignoredDomains);
    }

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
          ignored_domains: Array.from(ignoredDomains)
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

  // 既にブロック済みか確認
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const existingRule = existingRules.find(r =>
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
        priority: 1,
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
        ignored_domains: Array.from(ignoredDomains)
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
});

// 拡張機能アイコンクリックでサイドパネルを開く
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// サイドパネルの動作設定
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
