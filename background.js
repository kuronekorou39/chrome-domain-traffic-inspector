// Domain Traffic Inspector - Background Service Worker
importScripts('lib/domain-utils.js');

// タブごとのデータを管理
const tabData = new Map();
const TAB_DATA_STORAGE_KEY = 'tabData';

// 許可ドメインリスト（厳格モードおよび親ブロックの例外用）
let allowedDomains = new Set();

// ドメインルール（メタデータ層）
let domainRules = Object.create(null);

// 閲覧サイトごとの厳格ポリシー。キーは登録ドメイン、値はサイト内だけで有効なルール。
let sitePolicies = Object.create(null);
const SITE_POLICIES_STORAGE_KEY = 'sitePolicies';

// 動的ルールのIDカウンター（Service Worker再起動対策）
let ruleIdCounter = 1000;

// 厳格モードのブロックルールID（固定）
const STRICT_MODE_BLOCK_RULE_ID = 1;
const POLICY_RULE_ID_START = 1000;
const POLICY_PRIORITY_BASE = 100;
const SITE_DEFAULT_PRIORITY = 10000;
const SITE_POLICY_PRIORITY_BASE = 11000;
const TEMPORARY_ALLOW_PRIORITY_BASE = 12000;
const TEMPORARY_ALLOW_MINUTES = 5;
const TEMPORARY_ALLOW_ALARM_PREFIX = 'temporary-allow:';
const TOP_DOMAINS_MIN_CHROME_VERSION = 145;
// Chrome 114〜119 の動的ルール上限5000件から厳格モード用の1件を予約する。
const MAX_POLICY_RULES = 4999;
const MAX_DYNAMIC_RULES = 5000;

// 監視対象リソースタイプ（共通定数）
const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script',
  'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report',
  'media', 'websocket', 'webtransport', 'webbundle', 'other'
];

// 現在のモード（'normal' or 'strict'）
let currentMode = 'normal';

// ブロック機能の有効/無効（グローバル）
let blockingEnabled = true;

// 初期化完了フラグ
let initialized = false;
let initializationPromise = null;

// ブロックドメインのキャッシュ（毎リクエストでAPI呼出しを避ける）
let blockedDomainsCache = null;

// domainRulesの変更フラグ（変更時のみUPDATE_COUNTSに含める）
let domainRulesDirty = true;

// UPDATE_COUNTSスロットリング用
const pendingUpdates = new Map(); // tabId -> scheduled flag
const UPDATE_THROTTLE_MS = 500;
let persistenceTimer = null;
const PERSIST_THROTTLE_MS = 1500;

// DNRと保存状態を同時に変更する操作を直列化する。
let policyMutationQueue = Promise.resolve();

// domainRulesをストレージから読み込み
async function loadDomainRules() {
  const result = await chrome.storage.local.get(['domainRules']);
  domainRules = sanitizeRuleMap(result.domainRules);
}

function getChromeMajorVersion() {
  if (typeof navigator === 'undefined') return 0;
  const brands = navigator.userAgentData?.brands || [];
  const chromiumBrand = brands.find(brand => /Chromium|Google Chrome/.test(brand.brand));
  if (chromiumBrand) return Number.parseInt(chromiumBrand.version, 10) || 0;
  const match = navigator.userAgent?.match(/Chrom(?:e|ium)\/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function supportsTopDomainRules() {
  return getChromeMajorVersion() >= TOP_DOMAINS_MIN_CHROME_VERSION;
}

function getSiteDomain(value) {
  const domain = normalizeDomain(value);
  return domain ? getDomainRoot(domain) : null;
}

function sanitizeTemporaryAllows(value) {
  const sanitized = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return sanitized;
  for (const [rawDomain, rawExpiresAt] of Object.entries(value)) {
    const domain = normalizeDomain(rawDomain);
    const expiresAt = Number(rawExpiresAt);
    if (domain && Number.isFinite(expiresAt) && expiresAt > 0) sanitized[domain] = expiresAt;
  }
  return sanitized;
}

function sanitizeSitePolicies(value) {
  const sanitized = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return sanitized;
  for (const [rawSiteDomain, rawPolicy] of Object.entries(value)) {
    const siteDomain = getSiteDomain(rawSiteDomain);
    if (!siteDomain || !rawPolicy || typeof rawPolicy !== 'object') continue;
    sanitized[siteDomain] = {
      enabled: rawPolicy.enabled === true,
      rules: sanitizeRuleMap(rawPolicy.rules),
      temporaryAllows: sanitizeTemporaryAllows(rawPolicy.temporaryAllows)
    };
  }
  return sanitized;
}

async function loadSitePolicies() {
  const result = await chrome.storage.local.get([SITE_POLICIES_STORAGE_KEY]);
  sitePolicies = sanitizeSitePolicies(result[SITE_POLICIES_STORAGE_KEY]);
}

async function saveSitePolicies() {
  await chrome.storage.local.set({ [SITE_POLICIES_STORAGE_KEY]: sitePolicies });
}

function getTemporaryAllowAlarmName(siteDomain, domain) {
  return `${TEMPORARY_ALLOW_ALARM_PREFIX}${encodeURIComponent(siteDomain)}:${encodeURIComponent(domain)}`;
}

function parseTemporaryAllowAlarmName(name) {
  if (!name.startsWith(TEMPORARY_ALLOW_ALARM_PREFIX)) return null;
  const parts = name.slice(TEMPORARY_ALLOW_ALARM_PREFIX.length).split(':');
  if (parts.length !== 2) return null;
  try {
    return { siteDomain: decodeURIComponent(parts[0]), domain: decodeURIComponent(parts[1]) };
  } catch {
    return null;
  }
}

function purgeExpiredTemporaryAllows(now = Date.now()) {
  let changed = false;
  for (const policy of Object.values(sitePolicies)) {
    for (const [domain, expiresAt] of Object.entries(policy.temporaryAllows)) {
      if (expiresAt <= now) {
        delete policy.temporaryAllows[domain];
        changed = true;
      }
    }
  }
  return changed;
}

async function syncTemporaryAllowAlarms() {
  const expected = new Map();
  for (const [siteDomain, policy] of Object.entries(sitePolicies)) {
    for (const [domain, expiresAt] of Object.entries(policy.temporaryAllows)) {
      expected.set(getTemporaryAllowAlarmName(siteDomain, domain), expiresAt);
    }
  }

  const existing = await chrome.alarms.getAll();
  for (const alarm of existing) {
    if (alarm.name.startsWith(TEMPORARY_ALLOW_ALARM_PREFIX) && !expected.has(alarm.name)) {
      await chrome.alarms.clear(alarm.name);
    }
  }
  for (const [name, when] of expected) {
    await chrome.alarms.create(name, { when });
  }
}

function getSitePolicyState(mainDomain) {
  const siteDomain = getSiteDomain(mainDomain);
  const policy = siteDomain ? sitePolicies[siteDomain] : null;
  return {
    site_domain: siteDomain,
    enabled: Boolean(policy?.enabled),
    rules: policy?.rules || Object.create(null),
    temporary_allows: policy?.temporaryAllows || Object.create(null),
    precise_scope: supportsTopDomainRules()
  };
}

function sanitizeRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  if (rule.action !== 'block' && rule.action !== 'allow') return null;

  const memo = typeof rule.memo === 'string' ? rule.memo.trim().slice(0, 500) : '';
  const tags = Array.isArray(rule.tags)
    ? [...new Set(rule.tags
      .filter(tag => typeof tag === 'string')
      .map(tag => tag.trim().slice(0, 32))
      .filter(Boolean))].slice(0, 20)
    : [];

  return { action: rule.action, memo, tags };
}

function sanitizeRuleMap(value) {
  const sanitized = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return sanitized;

  for (const [rawDomain, rawRule] of Object.entries(value)) {
    const domain = normalizeDomain(rawDomain);
    const rule = sanitizeRule(rawRule);
    if (domain && rule) sanitized[domain] = rule;
  }
  return sanitized;
}

function requireDomain(value) {
  const domain = normalizeDomain(value);
  if (!domain) throw new Error('無効なドメインです');
  return domain;
}

function requireDomainList(value) {
  if (!Array.isArray(value) || value.length > MAX_POLICY_RULES) {
    throw new Error('ドメイン一覧が不正です');
  }
  return [...new Set(value.map(requireDomain))];
}

function requireRuleMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ルールデータが不正です');
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_POLICY_RULES) {
    throw new Error('ルール件数が不正です');
  }

  const validated = Object.create(null);
  for (const [rawDomain, rawRule] of entries) {
    const domain = requireDomain(rawDomain);
    const rule = sanitizeRule(rawRule);
    if (!rule) throw new Error(`${rawDomain}: ルール形式が不正です`);
    validated[domain] = rule;
  }
  return validated;
}

function requireTags(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error('タグ一覧が不正です');
  }
  return [...new Set(value.map(tag => {
    if (typeof tag !== 'string') throw new Error('タグは文字列で指定してください');
    const normalized = tag.trim();
    if (!normalized || normalized.length > 32) throw new Error('タグは1〜32文字で指定してください');
    return normalized;
  }))];
}

function serializeTabData() {
  return Object.fromEntries(Array.from(tabData.entries()).map(([tabId, data]) => [String(tabId), {
    domain_counts: data.domain_counts,
    main_domain: data.main_domain
  }]));
}

async function restoreTabData() {
  const result = await chrome.storage.session.get([TAB_DATA_STORAGE_KEY]);
  const stored = result[TAB_DATA_STORAGE_KEY];
  if (!stored || typeof stored !== 'object') return;

  for (const [rawTabId, data] of Object.entries(stored)) {
    const tabId = Number(rawTabId);
    if (!Number.isInteger(tabId) || !data || typeof data !== 'object') continue;
    tabData.set(tabId, {
      domain_counts: data.domain_counts && typeof data.domain_counts === 'object'
        ? data.domain_counts
        : {},
      main_domain: typeof data.main_domain === 'string' ? data.main_domain : null
    });
  }
}

async function persistTabData() {
  await chrome.storage.session.set({ [TAB_DATA_STORAGE_KEY]: serializeTabData() });
}

function scheduleTabDataPersistence() {
  if (persistenceTimer !== null) return;
  persistenceTimer = setTimeout(() => {
    persistenceTimer = null;
    persistTabData().catch(error => console.error('Failed to persist tab data:', error));
  }, PERSIST_THROTTLE_MS);
}

// domainRulesをストレージに保存
async function saveDomainRules() {
  domainRulesDirty = true;
  await chrome.storage.local.set({ domainRules });
}

function cloneDomainRules(value = domainRules) {
  return sanitizeRuleMap(JSON.parse(JSON.stringify(value)));
}

function cloneSitePolicies(value = sitePolicies) {
  return sanitizeSitePolicies(JSON.parse(JSON.stringify(value)));
}

async function capturePolicySnapshot() {
  return {
    allowedDomains: Array.from(allowedDomains),
    domainRules: cloneDomainRules(),
    sitePolicies: cloneSitePolicies(),
    currentMode,
    blockingEnabled,
    ruleIdCounter,
    dynamicRules: await chrome.declarativeNetRequest.getDynamicRules()
  };
}

async function restorePolicySnapshot(snapshot) {
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: currentRules.map(rule => rule.id),
    addRules: snapshot.dynamicRules
  });

  allowedDomains = new Set(snapshot.allowedDomains);
  domainRules = cloneDomainRules(snapshot.domainRules);
  sitePolicies = cloneSitePolicies(snapshot.sitePolicies);
  currentMode = snapshot.currentMode;
  blockingEnabled = snapshot.blockingEnabled;
  ruleIdCounter = snapshot.ruleIdCounter;
  domainRulesDirty = true;
  invalidateBlockedDomainsCache();

  await chrome.storage.local.set({
    allowedDomains: snapshot.allowedDomains,
    domainRules,
    [SITE_POLICIES_STORAGE_KEY]: sitePolicies,
    currentMode,
    blockingEnabled
  });
  await syncTemporaryAllowAlarms();
  updateIconBadge();
}

function runPolicyMutation(operation) {
  const mutation = policyMutationQueue.then(async () => {
    const snapshot = await capturePolicySnapshot();
    try {
      return await operation();
    } catch (error) {
      try {
        await restorePolicySnapshot(snapshot);
      } catch (rollbackError) {
        console.error('Failed to restore policy state:', rollbackError);
        error.message = `${error.message}（状態の復元にも失敗しました）`;
      }
      throw error;
    }
  });

  policyMutationQueue = mutation.catch(() => {});
  return mutation;
}

function getPolicyPriority(domain) {
  // DNR は同じ拡張機能内では数値の大きい priority を優先する。
  // ラベル数を加えることで、親ドメインより具体的な子ドメインの例外を優先する。
  return POLICY_PRIORITY_BASE + domain.split('.').length;
}

function createPolicyDnrRule(domain, action) {
  return {
    id: ruleIdCounter++,
    priority: getPolicyPriority(domain),
    action: { type: action },
    condition: {
      requestDomains: [domain],
      resourceTypes: ALL_RESOURCE_TYPES
    }
  };
}

function createSiteScopeCondition(siteDomain) {
  return supportsTopDomainRules()
    ? { topDomains: [siteDomain] }
    : { initiatorDomains: [siteDomain] };
}

function createSitePolicyDnrRules(siteDomain, policy) {
  if (!policy.enabled) return [];
  const scopeCondition = createSiteScopeCondition(siteDomain);
  const rules = [{
    id: ruleIdCounter++,
    priority: SITE_DEFAULT_PRIORITY,
    action: { type: 'block' },
    condition: {
      ...scopeCondition,
      resourceTypes: ALL_RESOURCE_TYPES
    }
  }];

  for (const [domain, rule] of Object.entries(policy.rules)) {
    rules.push({
      id: ruleIdCounter++,
      priority: SITE_POLICY_PRIORITY_BASE + domain.split('.').length,
      action: { type: rule.action },
      condition: {
        ...scopeCondition,
        requestDomains: [domain],
        resourceTypes: ALL_RESOURCE_TYPES
      }
    });
  }

  for (const domain of Object.keys(policy.temporaryAllows)) {
    rules.push({
      id: ruleIdCounter++,
      priority: TEMPORARY_ALLOW_PRIORITY_BASE + domain.split('.').length,
      action: { type: 'allow' },
      condition: {
        ...scopeCondition,
        requestDomains: [domain],
        resourceTypes: ALL_RESOURCE_TYPES
      }
    });
  }
  return rules;
}

function isGlobalPolicyDnrRule(rule) {
  return rule.id !== STRICT_MODE_BLOCK_RULE_ID &&
    (rule.action?.type === 'block' || rule.action?.type === 'allow') &&
    Array.isArray(rule.condition?.requestDomains) &&
    !rule.condition.topDomains && !rule.condition.initiatorDomains;
}

async function replacePolicyDnrRule(domain, action) {
  if (!blockingEnabled) return;
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = rules
    .filter(rule => isGlobalPolicyDnrRule(rule) && rule.condition.requestDomains.includes(domain))
    .map(rule => rule.id);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: [createPolicyDnrRule(domain, action)]
  });
  invalidateBlockedDomainsCache();
}

async function removePolicyDnrRule(domain, action) {
  if (!blockingEnabled) return;
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = rules
    .filter(rule => isGlobalPolicyDnrRule(rule) &&
      rule.action.type === action &&
      rule.condition.requestDomains.includes(domain))
    .map(rule => rule.id);
  if (removeRuleIds.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    invalidateBlockedDomainsCache();
  }
}

async function rebuildDynamicRules() {
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = currentRules.map(rule => rule.id);
  const addRules = [];

  ruleIdCounter = POLICY_RULE_ID_START;
  if (blockingEnabled) {
    if (currentMode === 'strict') {
      addRules.push({
        id: STRICT_MODE_BLOCK_RULE_ID,
        priority: 1,
        action: { type: 'block' },
        condition: { resourceTypes: ALL_RESOURCE_TYPES }
      });
    }
    for (const [domain, rule] of Object.entries(domainRules)) {
      addRules.push(createPolicyDnrRule(domain, rule.action));
    }
    for (const [siteDomain, policy] of Object.entries(sitePolicies)) {
      addRules.push(...createSitePolicyDnrRules(siteDomain, policy));
    }
  }

  if (addRules.length > MAX_DYNAMIC_RULES) {
    throw new Error(`有効な通信ルールが上限${MAX_DYNAMIC_RULES}件を超えています`);
  }

  if (removeRuleIds.length > 0 || addRules.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    invalidateBlockedDomainsCache();
  }
}

// 初期化時に既存のルールを確認し、ルールIDカウンターを設定
async function initialize() {
  if (initialized) return;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    // 既存の動的ルールを取得してカウンターを設定
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    if (rules.length > 0) {
      const maxId = Math.max(...rules.map(r => r.id));
      ruleIdCounter = Math.max(ruleIdCounter, maxId + 1);
    }

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
    await loadSitePolicies();
    await restoreTabData();

    // マイグレーション（初回のみ）
    const migResult = await chrome.storage.local.get(['migrationDone']);
    if (!migResult.migrationDone) {
      await migrateToRules(rules);
      await chrome.storage.local.set({ migrationDone: true });
    }

    await reconcilePolicyState();
    if (purgeExpiredTemporaryAllows()) await saveSitePolicies();
    await syncTemporaryAllowAlarms();
    // 保存状態を正としてDNRを再構築し、旧バージョンの優先度や許可方式も更新する。
    await rebuildDynamicRules();

    // アイコンバッジを更新
    updateIconBadge();

    initialized = true;
  })();

  try {
    await initializationPromise;
  } catch (error) {
    initializationPromise = null;
    console.error('Initialization error:', error);
    throw error;
  }
}

// 既存データをdomainRulesにマイグレーション
async function migrateToRules(existingRules) {
  let changed = false;

  // declarativeNetRequestの既存ブロックルール → action: "block"
  for (const rule of existingRules) {
    if (rule.id === STRICT_MODE_BLOCK_RULE_ID || rule.action?.type !== 'block') continue;
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
  try {
    await rebuildDynamicRules();

    await saveBlockingEnabled();
    updateIconBadge();
  } catch (error) {
    try {
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      const ruleIds = rules.map(rule => rule.id);
      if (ruleIds.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ruleIds });
        invalidateBlockedDomainsCache();
      }
    } catch (rollbackError) {
      console.error('Failed to roll back blocking rules:', rollbackError);
    }
    blockingEnabled = false;
    await saveBlockingEnabled();
    updateIconBadge();
    throw error;
  }
}

async function reconcilePolicyState() {
  let rulesChanged = false;
  let allowedChanged = false;

  for (const domain of allowedDomains) {
    if (!domainRules[domain]) {
      domainRules[domain] = { action: 'allow', memo: '', tags: [] };
      rulesChanged = true;
    }
  }

  const canonicalAllowed = new Set();
  for (const [domain, rule] of Object.entries(domainRules)) {
    if (rule.action === 'allow') canonicalAllowed.add(domain);
  }
  if (canonicalAllowed.size !== allowedDomains.size ||
      [...canonicalAllowed].some(domain => !allowedDomains.has(domain))) {
    allowedDomains = canonicalAllowed;
    allowedChanged = true;
  }

  if (rulesChanged) await saveDomainRules();
  if (allowedChanged) await saveAllowedDomains();
}

// ブロック機能を無効化（すべてのルールを一時的に削除）
async function disableBlocking() {
  // すべての動的ルールを削除
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const ruleIds = rules.map(r => r.id);
  if (ruleIds.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: ruleIds
    });
    invalidateBlockedDomainsCache();
  }

  blockingEnabled = false;
  await saveBlockingEnabled();
  updateIconBadge();
}

// 厳格モードを有効化
async function enableStrictMode() {
  const previousMode = currentMode;
  currentMode = 'strict';
  try {
    await updateStrictModeRule();
    await saveCurrentMode();
  } catch (error) {
    currentMode = previousMode;
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [STRICT_MODE_BLOCK_RULE_ID]
      });
      invalidateBlockedDomainsCache();
    } catch (rollbackError) {
      console.error('Failed to roll back strict mode:', rollbackError);
    }
    console.error('Failed to enable strict mode:', error);
    throw error;
  }
}

// 厳格モードを無効化
async function disableStrictMode() {
  // 厳格モードのブロックルールを削除
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [STRICT_MODE_BLOCK_RULE_ID]
  });
  invalidateBlockedDomainsCache();
  currentMode = 'normal';
  await saveCurrentMode();
}

// ドメインを許可（厳格モードまたは親ブロックの例外）
async function allowDomain(domain) {
  domain = requireDomain(domain);
  allowedDomains.add(domain);

  // domainRulesに同期
  if (!domainRules[domain]) {
    domainRules[domain] = { action: 'allow', memo: '', tags: [] };
  } else {
    domainRules[domain].action = 'allow';
  }
  await saveAllowedDomains();
  await saveDomainRules();
  await replacePolicyDnrRule(domain, 'allow');
}

// ドメインがブロックされているか確認
async function isBlockedDomain(domain) {
  domain = requireDomain(domain);
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return rules.some(r =>
    isGlobalPolicyDnrRule(r) && r.action.type === 'block' &&
    r.condition.requestDomains &&
    r.condition.requestDomains.includes(domain)
  );
}

// ドメインの許可を取り消し
async function disallowDomain(domain) {
  domain = requireDomain(domain);
  allowedDomains.delete(domain);
  await saveAllowedDomains();

  if (domainRules[domain]?.action === 'allow') {
    delete domainRules[domain];
    await saveDomainRules();
  }
  await removePolicyDnrRule(domain, 'allow');
}

// 厳格モードのルールを更新
async function updateStrictModeRule() {
  const update = { removeRuleIds: [STRICT_MODE_BLOCK_RULE_ID] };

  if (blockingEnabled && currentMode === 'strict') {
    update.addRules = [{
      id: STRICT_MODE_BLOCK_RULE_ID,
      priority: 1,
      action: { type: 'block' },
      condition: { resourceTypes: ALL_RESOURCE_TYPES }
    }];
  }

  await chrome.declarativeNetRequest.updateDynamicRules(update);
  invalidateBlockedDomainsCache();
}

function requireSiteDomain(value) {
  const siteDomain = getSiteDomain(value);
  if (!siteDomain) throw new Error('対象サイトが不正です');
  return siteDomain;
}

function ensureSitePolicy(siteDomain) {
  if (!sitePolicies[siteDomain]) {
    sitePolicies[siteDomain] = {
      enabled: false,
      rules: Object.create(null),
      temporaryAllows: Object.create(null)
    };
  }
  return sitePolicies[siteDomain];
}

async function enableSitePolicy(rawSiteDomain) {
  const siteDomain = requireSiteDomain(rawSiteDomain);
  const policy = ensureSitePolicy(siteDomain);
  policy.enabled = true;
  // サイト本体は起点として必ず通し、外部依存だけを既定停止する。
  policy.rules[siteDomain] = {
    action: 'allow',
    memo: policy.rules[siteDomain]?.memo || 'サイト本体',
    tags: policy.rules[siteDomain]?.tags || ['first-party']
  };
  await saveSitePolicies();
  await rebuildDynamicRules();
  return getSitePolicyState(siteDomain);
}

async function disableSitePolicy(rawSiteDomain) {
  const siteDomain = requireSiteDomain(rawSiteDomain);
  const policy = ensureSitePolicy(siteDomain);
  policy.enabled = false;
  await saveSitePolicies();
  await rebuildDynamicRules();
  return getSitePolicyState(siteDomain);
}

async function setSiteRule(rawSiteDomain, rawDomain, action) {
  const siteDomain = requireSiteDomain(rawSiteDomain);
  const domain = requireDomain(rawDomain);
  if (action !== 'allow' && action !== 'block') throw new Error('アクションが不正です');
  const policy = ensureSitePolicy(siteDomain);
  if (!policy.enabled) throw new Error('先にサイト保護を有効にしてください');
  if (domain === siteDomain && action !== 'allow') {
    throw new Error('サイト本体はサイト保護の起点として許可されます');
  }
  const existing = policy.rules[domain];
  policy.rules[domain] = {
    action,
    memo: existing?.memo || '',
    tags: existing?.tags || []
  };
  delete policy.temporaryAllows[domain];
  await saveSitePolicies();
  await syncTemporaryAllowAlarms();
  await rebuildDynamicRules();
  return getSitePolicyState(siteDomain);
}

async function deleteSiteRule(rawSiteDomain, rawDomain) {
  const siteDomain = requireSiteDomain(rawSiteDomain);
  const domain = requireDomain(rawDomain);
  const policy = ensureSitePolicy(siteDomain);
  if (domain === siteDomain && policy.enabled) {
    throw new Error('サイト本体の許可ルールはサイト保護中に削除できません');
  }
  delete policy.rules[domain];
  delete policy.temporaryAllows[domain];
  await saveSitePolicies();
  await syncTemporaryAllowAlarms();
  await rebuildDynamicRules();
  return getSitePolicyState(siteDomain);
}

async function bulkAllowSiteDomains(rawSiteDomain, rawDomains) {
  const siteDomain = requireSiteDomain(rawSiteDomain);
  const domains = requireDomainList(rawDomains);
  const policy = ensureSitePolicy(siteDomain);
  if (!policy.enabled) throw new Error('先にサイト保護を有効にしてください');
  for (const domain of domains) {
    const existing = policy.rules[domain];
    policy.rules[domain] = {
      action: 'allow',
      memo: existing?.memo || '',
      tags: existing?.tags || []
    };
    delete policy.temporaryAllows[domain];
  }
  await saveSitePolicies();
  await syncTemporaryAllowAlarms();
  await rebuildDynamicRules();
  return getSitePolicyState(siteDomain);
}

async function temporarilyAllowSiteDomain(rawSiteDomain, rawDomain) {
  const siteDomain = requireSiteDomain(rawSiteDomain);
  const domain = requireDomain(rawDomain);
  const policy = ensureSitePolicy(siteDomain);
  if (!policy.enabled) throw new Error('先にサイト保護を有効にしてください');
  policy.temporaryAllows[domain] = Date.now() + TEMPORARY_ALLOW_MINUTES * 60 * 1000;
  await saveSitePolicies();
  await syncTemporaryAllowAlarms();
  await rebuildDynamicRules();
  return getSitePolicyState(siteDomain);
}

async function removeTemporarySiteAllow(rawSiteDomain, rawDomain) {
  const siteDomain = requireSiteDomain(rawSiteDomain);
  const domain = requireDomain(rawDomain);
  const policy = ensureSitePolicy(siteDomain);
  delete policy.temporaryAllows[domain];
  await saveSitePolicies();
  await syncTemporaryAllowAlarms();
  await rebuildDynamicRules();
  return getSitePolicyState(siteDomain);
}

// 初期化を実行
initialize().catch(() => {});

// extractDomain, getShortType は lib/domain-utils.js から提供

// タブデータを初期化
function initTabData(tabId) {
  if (!tabData.has(tabId)) {
    tabData.set(tabId, {
      domain_counts: {},
      main_domain: null
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
          blocking_enabled: blockingEnabled,
          site_policy: getSitePolicyState(data.main_domain)
        }
      };
      // domainRulesは変更時のみ含める
      if (domainRulesDirty) {
        message.data.domain_rules = domainRules;
        domainRulesDirty = false;
      }
      chrome.runtime.sendMessage(message).catch(() => {});
      scheduleTabDataPersistence();
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
  scheduleTabDataPersistence();
});

// タブがナビゲートしたらカウントをリセット＆メインドメインを記録
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    const data = initTabData(tabId);
    data.domain_counts = {};
    data.main_domain = extractDomain(changeInfo.url);
    scheduleTabDataPersistence();
  }
});

// ドメインをブロック（全タブ対象）
async function blockDomain(domain) {
  await initialize();
  domain = requireDomain(domain);

  // 許可リストから削除（相互排他）
  if (allowedDomains.delete(domain)) {
    await saveAllowedDomains();
  }

  domainRules[domain] = {
    action: 'block',
    memo: domainRules[domain]?.memo || '',
    tags: domainRules[domain]?.tags || []
  };
  await saveDomainRules();
  await replacePolicyDnrRule(domain, 'block');
}

// ドメインのブロックを解除
async function unblockDomain(domain) {
  await initialize();
  domain = requireDomain(domain);

  await removePolicyDnrRule(domain, 'block');
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
    if (isGlobalPolicyDnrRule(rule) && rule.action.type === 'block') {
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
    if (!Number.isInteger(msg.tabId) || msg.tabId < 0) throw new Error('タブIDが不正です');
    const data = initTabData(msg.tabId);
    if (!data.main_domain) {
      try {
        const tab = await chrome.tabs.get(msg.tabId);
        data.main_domain = extractDomain(tab.url || '');
        if (data.main_domain) await persistTabData();
      } catch {
        // chrome:// などURLへアクセスできないタブでは null のまま扱う。
      }
    }
    const blockedDomains = await getBlockedDomains();
    return {
      domain_counts: data?.domain_counts || {},
      main_domain: data?.main_domain || null,
      blocked_domains: blockedDomains,
      mode: currentMode,
      allowed_domains: Array.from(allowedDomains),
      blocking_enabled: blockingEnabled,
      domain_rules: domainRules,
      site_policy: getSitePolicyState(data?.main_domain)
    };
  },

  BLOCK_DOMAIN: async (msg) => {
    await blockDomain(msg.domain);
    return fullStateResponse();
  },

  UNBLOCK_DOMAIN: async (msg) => {
    const domain = requireDomain(msg.domain);
    await unblockDomain(domain);
    // 非アクティブなルール型は持たないため、解除時はメタデータごと削除する。
    if (domainRules[domain]?.action === 'block') {
      delete domainRules[domain];
      await saveDomainRules();
    }
    return fullStateResponse();
  },

  CLEAR_COUNTS: (msg) => {
    const data = tabData.get(msg.tabId);
    if (data) data.domain_counts = {};
    persistTabData().catch(error => console.error('Failed to persist cleared counts:', error));
    return { success: true };
  },

  BULK_BLOCK: async (msg) => {
    for (const domain of requireDomainList(msg.domains)) {
      await blockDomain(domain);
    }
    return fullStateResponse();
  },

  BULK_ALLOW: async (msg) => {
    for (const domain of requireDomainList(msg.domains)) {
      await allowDomain(domain);
    }
    return fullStateResponse();
  },

  ENABLE_SITE_POLICY: async (msg) => ({
    success: true,
    site_policy: await enableSitePolicy(msg.siteDomain)
  }),

  DISABLE_SITE_POLICY: async (msg) => ({
    success: true,
    site_policy: await disableSitePolicy(msg.siteDomain)
  }),

  SET_SITE_RULE: async (msg) => ({
    success: true,
    site_policy: await setSiteRule(msg.siteDomain, msg.domain, msg.action)
  }),

  DELETE_SITE_RULE: async (msg) => ({
    success: true,
    site_policy: await deleteSiteRule(msg.siteDomain, msg.domain)
  }),

  BULK_ALLOW_SITE_DOMAINS: async (msg) => ({
    success: true,
    site_policy: await bulkAllowSiteDomains(msg.siteDomain, msg.domains)
  }),

  TEMPORARILY_ALLOW_SITE_DOMAIN: async (msg) => ({
    success: true,
    site_policy: await temporarilyAllowSiteDomain(msg.siteDomain, msg.domain)
  }),

  REMOVE_TEMPORARY_SITE_ALLOW: async (msg) => ({
    success: true,
    site_policy: await removeTemporarySiteAllow(msg.siteDomain, msg.domain)
  }),

  GET_MODE: async () => ({
    mode: currentMode,
    allowed_domains: Array.from(allowedDomains)
  }),

  SET_MODE: async (msg) => {
    if (msg.mode === 'strict') {
      await enableStrictMode();
    } else if (msg.mode === 'normal') {
      await disableStrictMode();
    } else {
      throw new Error('モードが不正です');
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
    const domain = requireDomain(msg.domain);
    if (!domainRules[domain]) {
      return { success: false, error: 'Rule not found' };
    }
    if (msg.memo !== undefined) {
      if (typeof msg.memo !== 'string' || msg.memo.length > 500) throw new Error('メモは500文字以内です');
      domainRules[domain].memo = msg.memo.trim();
    }
    if (msg.tags !== undefined) domainRules[domain].tags = requireTags(msg.tags);
    await saveDomainRules();
    return { success: true, domain_rules: domainRules };
  },

  SET_RULE_ACTION: async (msg) => {
    const domain = requireDomain(msg.domain);
    if (msg.action === 'block') {
      await blockDomain(domain);
    } else if (msg.action === 'allow') {
      if (await isBlockedDomain(domain)) {
        await unblockDomain(domain);
      }
      await allowDomain(domain);
    } else {
      throw new Error('アクションが不正です');
    }
    return fullStateResponse();
  },

  DELETE_RULE: async (msg) => {
    const domain = requireDomain(msg.domain);
    const rule = domainRules[domain];
    if (rule) {
      if (rule.action === 'block') await unblockDomain(domain);
      else if (rule.action === 'allow') await disallowDomain(domain);
      delete domainRules[domain];
      await saveDomainRules();
    }
    return fullStateResponse();
  },

  BULK_UPDATE_TAGS: async (msg) => {
    const domains = requireDomainList(msg.domains);
    const addTags = requireTags(msg.addTags);
    for (const domain of domains) {
      if (domainRules[domain]) {
        const existing = domainRules[domain].tags || [];
        addTags.forEach(tag => {
          if (!existing.includes(tag)) existing.push(tag);
        });
        domainRules[domain].tags = existing;
      }
    }
    await saveDomainRules();
    return { success: true, domain_rules: domainRules };
  },

  IMPORT_RULES: async (msg) => {
    const importedRules = requireRuleMap(msg.rules);
    for (const [domain, rule] of Object.entries(importedRules)) {
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
    for (const domain of requireDomainList(msg.domains)) {
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
    const domain = requireDomain(msg.domain);
    if (msg.action === 'block') await blockDomain(domain);
    else if (msg.action === 'allow') await allowDomain(domain);
    else throw new Error('アクションが不正です');
    if (domainRules[domain]) {
      if (msg.memo !== undefined) {
        if (typeof msg.memo !== 'string' || msg.memo.length > 500) throw new Error('メモは500文字以内です');
        domainRules[domain].memo = msg.memo.trim();
      }
      if (msg.tags !== undefined) domainRules[domain].tags = requireTags(msg.tags);
      await saveDomainRules();
    }
    return fullStateResponse();
  }
};

const POLICY_MUTATION_TYPES = new Set([
  'ENABLE_BLOCKING', 'DISABLE_BLOCKING',
  'BLOCK_DOMAIN', 'UNBLOCK_DOMAIN', 'BULK_BLOCK', 'BULK_ALLOW',
  'ENABLE_SITE_POLICY', 'DISABLE_SITE_POLICY', 'SET_SITE_RULE', 'DELETE_SITE_RULE',
  'BULK_ALLOW_SITE_DOMAINS', 'TEMPORARILY_ALLOW_SITE_DOMAIN', 'REMOVE_TEMPORARY_SITE_ALLOW',
  'SET_MODE', 'ALLOW_DOMAIN', 'DISALLOW_DOMAIN',
  'UPDATE_RULE_META', 'SET_RULE_ACTION', 'DELETE_RULE',
  'BULK_UPDATE_TAGS', 'IMPORT_RULES', 'BULK_DELETE_RULES', 'ADD_RULE'
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = messageHandlers[message.type];
  if (!handler) return;

  // initialize()完了後にハンドラを実行
  initialize()
    .then(() => POLICY_MUTATION_TYPES.has(message.type)
      ? runPolicyMutation(() => handler(message))
      : policyMutationQueue.then(() => handler(message)))
    .then(sendResponse)
    .catch(err => {
      console.error(`Handler error [${message.type}]:`, err);
      sendResponse({ success: false, error: err.message });
    });
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  const target = parseTemporaryAllowAlarmName(alarm.name);
  if (!target) return;
  initialize()
    .then(() => runPolicyMutation(async () => {
      const policy = sitePolicies[target.siteDomain];
      const expiresAt = policy?.temporaryAllows?.[target.domain];
      if (!expiresAt) return;
      if (expiresAt > Date.now()) {
        await syncTemporaryAllowAlarms();
        return;
      }
      delete policy.temporaryAllows[target.domain];
      await saveSitePolicies();
      await syncTemporaryAllowAlarms();
      await rebuildDynamicRules();
      chrome.runtime.sendMessage({
        type: 'SITE_POLICY_UPDATED',
        siteDomain: target.siteDomain,
        sitePolicy: getSitePolicyState(target.siteDomain)
      }).catch(() => {});
    }))
    .catch(error => console.error('Failed to expire temporary allow:', error));
});

// 拡張機能アイコンクリックでサイドパネルを開く
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// サイドパネルの動作設定
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
