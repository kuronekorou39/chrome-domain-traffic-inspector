import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..');
const utilsCode = fs.readFileSync(path.join(projectRoot, 'lib/domain-utils.js'), 'utf8');
const backgroundCode = fs.readFileSync(path.join(projectRoot, 'background.js'), 'utf8');

function createHarness({
  tabUrl = 'https://example.com/path',
  initialLocal = {},
  initialSession = {},
  initialRules = []
} = {}) {
  const localStore = JSON.parse(JSON.stringify(initialLocal));
  const sessionStore = JSON.parse(JSON.stringify(initialSession));
  let dynamicRules = JSON.parse(JSON.stringify(initialRules));
  let messageListener;
  let dnrUpdatesBeforeFailure = null;
  const listeners = {};

  const clone = value => JSON.parse(JSON.stringify(value));
  const getValues = (store, keys) => {
    const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
    return Object.fromEntries(names
      .filter(key => Object.hasOwn(store, key))
      .map(key => [key, clone(store[key])]));
  };

  const event = name => ({
    addListener(listener) { listeners[name] = listener; }
  });
  const chrome = {
    storage: {
      local: {
        async get(keys) { return getValues(localStore, keys); },
        async set(values) { Object.assign(localStore, clone(values)); }
      },
      session: {
        async get(keys) { return getValues(sessionStore, keys); },
        async set(values) { Object.assign(sessionStore, clone(values)); }
      }
    },
    declarativeNetRequest: {
      async getDynamicRules() { return clone(dynamicRules); },
      async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
        if (dnrUpdatesBeforeFailure !== null) {
          dnrUpdatesBeforeFailure -= 1;
          if (dnrUpdatesBeforeFailure === 0) {
            dnrUpdatesBeforeFailure = null;
            throw new Error('DNR update failed');
          }
        }
        dynamicRules = dynamicRules.filter(rule => !removeRuleIds.includes(rule.id));
        for (const rule of addRules) {
          if (dynamicRules.some(existing => existing.id === rule.id)) {
            throw new Error(`Duplicate rule id: ${rule.id}`);
          }
          dynamicRules.push(clone(rule));
        }
      }
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
      onClicked: event('actionClicked')
    },
    tabs: {
      async get(tabId) { return { id: tabId, url: tabUrl }; },
      onRemoved: event('tabRemoved'),
      onUpdated: event('tabUpdated')
    },
    runtime: {
      onMessage: {
        addListener(listener) { messageListener = listener; }
      },
      async sendMessage() {}
    },
    webRequest: { onBeforeRequest: event('beforeRequest') },
    sidePanel: {
      async open() {},
      async setPanelBehavior() {}
    }
  };

  const context = vm.createContext({
    chrome,
    URL,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    importScripts() {}
  });
  new vm.Script(utilsCode, { filename: path.join(projectRoot, 'lib/domain-utils.js') }).runInContext(context);
  new vm.Script(backgroundCode, { filename: path.join(projectRoot, 'background.js') }).runInContext(context);

  const send = message => new Promise((resolve, reject) => {
    if (!messageListener) {
      reject(new Error('Message listener was not registered'));
      return;
    }
    const keepChannelOpen = messageListener(message, {}, resolve);
    if (keepChannelOpen !== true) reject(new Error('Message channel was not kept open'));
  });

  return {
    send,
    getRules: () => clone(dynamicRules),
    getLocalStore: () => clone(localStore),
    getSessionStore: () => clone(sessionStore),
    emitBeforeRequest(details) { listeners.beforeRequest?.(details); },
    emitTabUpdated(tabId, changeInfo) { listeners.tabUpdated?.(tabId, changeInfo); },
    emitTabRemoved(tabId) { listeners.tabRemoved?.(tabId); },
    rejectNextDnrUpdate() { dnrUpdatesBeforeFailure = 1; },
    rejectDnrUpdateIn(callCount) { dnrUpdatesBeforeFailure = callCount; }
  };
}

describe('background service worker', () => {
  it('厳格モードはメインフレームを含む全リソースを対象にする', async () => {
    const harness = createHarness();
    const response = await harness.send({ type: 'SET_MODE', mode: 'strict' });

    expect(response.success).toBe(true);
    const strictRule = harness.getRules().find(rule => rule.id === 1);
    expect(strictRule.condition).not.toHaveProperty('domainType');
    expect(strictRule.condition.resourceTypes).toContain('main_frame');
    expect(strictRule.condition.resourceTypes).toContain('csp_report');
    expect(strictRule.condition.resourceTypes).toContain('webtransport');
    expect(strictRule.condition.resourceTypes).toContain('webbundle');
    expect(strictRule.condition).not.toHaveProperty('excludedRequestDomains');
  });

  it('旧バージョンのサードパーティ限定ルールを起動時に置き換える', async () => {
    const harness = createHarness({
      initialLocal: {
        currentMode: 'strict',
        blockingEnabled: true,
        migrationDone: true,
        allowedDomains: [],
        domainRules: {}
      },
      initialRules: [{
        id: 1,
        priority: 1,
        action: { type: 'block' },
        condition: { resourceTypes: ['script'], domainType: 'thirdParty' }
      }]
    });

    await harness.send({ type: 'GET_TAB_DATA', tabId: 2 });
    const strictRule = harness.getRules().find(rule => rule.id === 1);
    expect(strictRule.condition).not.toHaveProperty('domainType');
    expect(strictRule.condition.resourceTypes).toContain('main_frame');
  });

  it('厳格モードの許可ドメインだけを全体ブロックから除外する', async () => {
    const harness = createHarness();
    await harness.send({ type: 'ALLOW_DOMAIN', domain: 'example.com' });
    await harness.send({ type: 'SET_MODE', mode: 'strict' });

    const strictRule = harness.getRules().find(rule => rule.id === 1);
    expect(strictRule.condition.excludedRequestDomains).toEqual(['example.com']);
    expect(strictRule.condition.resourceTypes).toContain('main_frame');
  });

  it('DNR更新失敗を成功扱いせずUIへ返す', async () => {
    const harness = createHarness();
    await harness.send({ type: 'GET_TAB_DATA', tabId: 7 });
    harness.rejectNextDnrUpdate();

    const response = await harness.send({ type: 'BLOCK_DOMAIN', domain: 'ads.example.com' });

    expect(response.success).toBe(false);
    expect(response.error).toContain('DNR update failed');
    expect(harness.getRules()).toHaveLength(0);
  });

  it('厳格モードの許可更新に失敗した場合はDNRと保存状態を復元する', async () => {
    const harness = createHarness();
    await harness.send({ type: 'SET_MODE', mode: 'strict' });
    harness.rejectNextDnrUpdate();

    const response = await harness.send({ type: 'ALLOW_DOMAIN', domain: 'example.com' });
    const state = await harness.send({ type: 'GET_TAB_DATA', tabId: 1 });

    expect(response.success).toBe(false);
    expect(state.allowed_domains).not.toContain('example.com');
    expect(state.domain_rules).not.toHaveProperty('example.com');
    expect(harness.getLocalStore().allowedDomains).not.toContain('example.com');
    expect(harness.getRules().find(rule => rule.id === 1).condition)
      .not.toHaveProperty('excludedRequestDomains');
  });

  it('厳格モードの許可解除に失敗した場合は許可状態を復元する', async () => {
    const harness = createHarness();
    await harness.send({ type: 'ALLOW_DOMAIN', domain: 'example.com' });
    await harness.send({ type: 'SET_MODE', mode: 'strict' });
    harness.rejectNextDnrUpdate();

    const response = await harness.send({ type: 'DISALLOW_DOMAIN', domain: 'example.com' });
    const state = await harness.send({ type: 'GET_TAB_DATA', tabId: 1 });

    expect(response.success).toBe(false);
    expect(state.allowed_domains).toContain('example.com');
    expect(state.domain_rules['example.com'].action).toBe('allow');
    expect(harness.getRules().find(rule => rule.id === 1).condition.excludedRequestDomains)
      .toEqual(['example.com']);
  });

  it('一括ブロックの途中で失敗した場合は部分適用を残さない', async () => {
    const harness = createHarness();
    harness.rejectDnrUpdateIn(2);

    const response = await harness.send({
      type: 'BULK_BLOCK',
      domains: ['one.example', 'two.example']
    });
    const state = await harness.send({ type: 'GET_TAB_DATA', tabId: 1 });

    expect(response.success).toBe(false);
    expect(state.blocked_domains).toEqual([]);
    expect(state.domain_rules).toEqual({});
    expect(harness.getRules()).toEqual([]);
  });

  it('グローバル停止中はルールを保存するがDNRへ適用しない', async () => {
    const harness = createHarness();
    await harness.send({ type: 'DISABLE_BLOCKING' });

    const added = await harness.send({
      type: 'ADD_RULE',
      domain: 'ads.example.com',
      action: 'block',
      memo: '広告',
      tags: ['tracking']
    });

    expect(added.success).toBe(true);
    expect(added.domain_rules['ads.example.com'].action).toBe('block');
    expect(harness.getRules()).toHaveLength(0);

    await harness.send({ type: 'ENABLE_BLOCKING' });
    expect(harness.getRules().some(rule =>
      rule.condition.requestDomains?.includes('ads.example.com')
    )).toBe(true);
  });

  it('通常モードで個別ブロックと解除をDNR・メタデータへ反映する', async () => {
    const harness = createHarness();

    const blocked = await harness.send({ type: 'BLOCK_DOMAIN', domain: 'ads.example.com' });
    const blockRule = harness.getRules().find(rule =>
      rule.condition.requestDomains?.includes('ads.example.com')
    );
    expect(blocked.success).toBe(true);
    expect(blocked.blocked_domains).toContain('ads.example.com');
    expect(blocked.domain_rules['ads.example.com'].action).toBe('block');
    expect(blockRule.condition.resourceTypes).toContain('main_frame');

    const unblocked = await harness.send({ type: 'UNBLOCK_DOMAIN', domain: 'ads.example.com' });
    expect(unblocked.blocked_domains).not.toContain('ads.example.com');
    expect(unblocked.domain_rules).not.toHaveProperty('ads.example.com');
    expect(harness.getRules()).toEqual([]);
  });

  it('同時に届いたポリシー変更を直列化して両方保持する', async () => {
    const harness = createHarness();

    const [first, second] = await Promise.all([
      harness.send({ type: 'BLOCK_DOMAIN', domain: 'one.example' }),
      harness.send({ type: 'BLOCK_DOMAIN', domain: 'two.example' })
    ]);
    const state = await harness.send({ type: 'GET_TAB_DATA', tabId: 1 });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(state.blocked_domains.sort()).toEqual(['one.example', 'two.example']);
    expect(Object.keys(state.domain_rules).sort()).toEqual(['one.example', 'two.example']);
  });

  it('ルールの追加・メタデータ更新・アクション変更・削除を同期する', async () => {
    const harness = createHarness();

    const added = await harness.send({
      type: 'ADD_RULE',
      domain: 'media.example.com',
      action: 'block',
      memo: ' initial ',
      tags: ['media']
    });
    expect(added.domain_rules['media.example.com']).toEqual({
      action: 'block', memo: 'initial', tags: ['media']
    });

    const updated = await harness.send({
      type: 'UPDATE_RULE_META',
      domain: 'media.example.com',
      memo: ' updated ',
      tags: ['media', 'trusted']
    });
    expect(updated.domain_rules['media.example.com'].memo).toBe('updated');

    const allowed = await harness.send({
      type: 'SET_RULE_ACTION',
      domain: 'media.example.com',
      action: 'allow'
    });
    expect(allowed.allowed_domains).toContain('media.example.com');
    expect(allowed.blocked_domains).not.toContain('media.example.com');
    expect(allowed.domain_rules['media.example.com'].tags).toEqual(['media', 'trusted']);

    const deleted = await harness.send({ type: 'DELETE_RULE', domain: 'media.example.com' });
    expect(deleted.allowed_domains).not.toContain('media.example.com');
    expect(deleted.domain_rules).not.toHaveProperty('media.example.com');
  });

  it('正常なインポートと一括タグ付け・削除を処理する', async () => {
    const harness = createHarness();
    const imported = await harness.send({
      type: 'IMPORT_RULES',
      rules: {
        'ads.example.com': { action: 'block', memo: '広告', tags: ['tracking'] },
        'cdn.example.com': { action: 'allow', memo: '配信', tags: ['cdn'] }
      }
    });

    expect(imported.blocked_domains).toContain('ads.example.com');
    expect(imported.allowed_domains).toContain('cdn.example.com');

    const tagged = await harness.send({
      type: 'BULK_UPDATE_TAGS',
      domains: ['ads.example.com', 'cdn.example.com'],
      addTags: ['reviewed']
    });
    expect(tagged.domain_rules['ads.example.com'].tags).toContain('reviewed');
    expect(tagged.domain_rules['cdn.example.com'].tags).toContain('reviewed');

    const deleted = await harness.send({
      type: 'BULK_DELETE_RULES',
      domains: ['ads.example.com', 'cdn.example.com']
    });
    expect(deleted.blocked_domains).toEqual([]);
    expect(deleted.allowed_domains).toEqual([]);
    expect(deleted.domain_rules).toEqual({});
  });

  it('許可解除時にdomainRulesも同期して削除する', async () => {
    const harness = createHarness();
    await harness.send({ type: 'ALLOW_DOMAIN', domain: 'cdn.example.com' });
    const response = await harness.send({ type: 'DISALLOW_DOMAIN', domain: 'cdn.example.com' });

    expect(response.success).toBe(true);
    expect(response.allowed_domains).not.toContain('cdn.example.com');
    expect(response.domain_rules).not.toHaveProperty('cdn.example.com');
  });

  it('危険または壊れたインポートデータを拒否する', async () => {
    const harness = createHarness();
    const rules = JSON.parse('{"__proto__":{"action":"allow","memo":"","tags":[]}}');
    const response = await harness.send({ type: 'IMPORT_RULES', rules });

    expect(response.success).toBe(false);
    expect(response.error).toContain('無効なドメイン');
    expect(Object.prototype).not.toHaveProperty('action');
  });

  it('既存タブのURLからメインドメインを復元してsessionへ保存する', async () => {
    const harness = createHarness({ tabUrl: 'https://news.example.jp/article' });
    const response = await harness.send({ type: 'GET_TAB_DATA', tabId: 11 });

    expect(response.main_domain).toBe('news.example.jp');
    expect(harness.getSessionStore().tabData['11'].main_domain).toBe('news.example.jp');
  });

  it('通信をタブ単位で集計し、クリアできる', async () => {
    const harness = createHarness();
    harness.emitTabUpdated(5, { url: 'https://app.example.com/' });
    harness.emitBeforeRequest({
      tabId: 5,
      url: 'https://api.example.net/data',
      type: 'xmlhttprequest'
    });
    harness.emitBeforeRequest({
      tabId: 5,
      url: 'https://api.example.net/next',
      type: 'xmlhttprequest'
    });

    const collected = await harness.send({ type: 'GET_TAB_DATA', tabId: 5 });
    expect(collected.main_domain).toBe('app.example.com');
    expect(collected.domain_counts['api.example.net']).toEqual({
      total: 2,
      types: { XHR: 2 }
    });

    await harness.send({ type: 'CLEAR_COUNTS', tabId: 5 });
    const cleared = await harness.send({ type: 'GET_TAB_DATA', tabId: 5 });
    expect(cleared.domain_counts).toEqual({});
  });

  it('保存済みのタブ集計をService Worker起動時に復元する', async () => {
    const harness = createHarness({
      initialSession: {
        tabData: {
          8: {
            main_domain: 'restored.example',
            domain_counts: {
              'api.restored.example': { total: 3, types: { XHR: 3 } }
            }
          }
        }
      }
    });

    const response = await harness.send({ type: 'GET_TAB_DATA', tabId: 8 });
    expect(response.main_domain).toBe('restored.example');
    expect(response.domain_counts['api.restored.example'].total).toBe(3);
  });

  it('不正なタブID・アクション・タグ・メモを拒否する', async () => {
    const harness = createHarness();

    expect((await harness.send({ type: 'GET_TAB_DATA', tabId: -1 })).success).toBe(false);
    expect((await harness.send({
      type: 'ADD_RULE', domain: 'example.com', action: 'invalid'
    })).success).toBe(false);
    expect((await harness.send({
      type: 'ADD_RULE', domain: 'example.com', action: 'block', tags: ['']
    })).success).toBe(false);
    expect((await harness.send({
      type: 'ADD_RULE', domain: 'example.com', action: 'block', memo: 'x'.repeat(501)
    })).success).toBe(false);

    const state = await harness.send({ type: 'GET_TAB_DATA', tabId: 1 });
    expect(state.domain_rules).toEqual({});
    expect(harness.getRules()).toEqual([]);
  });
});
