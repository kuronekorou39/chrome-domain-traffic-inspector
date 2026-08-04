import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..');
const sidepanelHtml = fs.readFileSync(path.join(projectRoot, 'sidepanel.html'), 'utf8');
const utilsCode = fs.readFileSync(path.join(projectRoot, 'lib/domain-utils.js'), 'utf8');
const sidepanelUrl = pathToFileURL(path.join(projectRoot, 'sidepanel.js')).href;
const sidepanelCode = fs.readFileSync(path.join(projectRoot, 'sidepanel.js'), 'utf8')
  .replace(/\/\/ 初期化[\s\S]*$/, 'globalThis.DomainTrafficInspector = DomainTrafficInspector;');

function createInspector() {
  const dom = new JSDOM(sidepanelHtml, {
    runScripts: 'outside-only',
    url: 'https://extension.test/sidepanel.html'
  });
  dom.window.eval(utilsCode);
  dom.window.eval(`${sidepanelCode}\n//# sourceURL=${sidepanelUrl}`);

  const inspector = Object.create(dom.window.DomainTrafficInspector.prototype);
  inspector.domainData = {
    domain_counts: {},
    main_domain: 'app.example.com',
    blocked_domains: [],
    mode: 'normal',
    allowed_domains: [],
    blocking_enabled: true,
    domain_rules: {},
    site_policy: {
      site_domain: 'example.com',
      enabled: false,
      rules: {},
      temporary_allows: {},
      precise_scope: true
    }
  };
  inspector.domainRules = {};
  inspector.policyScope = 'global';
  inspector.expandedTags = new Set();
  inspector.selectedRules = new Set();
  inspector.searchQueries = { traffic: '', rules: '' };
  inspector.activeTab = 'traffic';
  inspector.trafficFilter = 'all';
  inspector.sortBy = 'count';
  inspector.editingRuleDomain = null;
  inspector.showingAddForm = false;
  inspector.runAction = action => action();
  inspector.testDocument = dom.window.document;
  inspector.testWindow = dom.window;
  inspector.testClass = dom.window.DomainTrafficInspector;
  return inspector;
}

describe('sidepanel UI logic', () => {
  let inspector;

  beforeEach(() => {
    inspector = createInspector();
  });

  it('HTML本文と属性に使う文字をエスケープする', () => {
    expect(inspector.escapeHtml(`<tag a="x">'&`))
      .toBe('&lt;tag a=&quot;x&quot;&gt;&#39;&amp;');
  });

  it('厳格モードではファーストパーティを含む未許可ドメインを停止扱いにする', () => {
    inspector.domainData.mode = 'strict';

    expect(inspector.isDomainEffectivelyBlocked('app.example.com')).toBe(true);
    expect(inspector.isDomainEffectivelyBlocked('third-party.example')).toBe(true);

    inspector.domainData.allowed_domains = ['app.example.com'];
    inspector.domainRules = {
      'app.example.com': { action: 'allow', memo: '', tags: [] }
    };
    expect(inspector.isDomainEffectivelyBlocked('app.example.com')).toBe(false);

    inspector.domainData.blocking_enabled = false;
    expect(inspector.isDomainEffectivelyBlocked('third-party.example')).toBe(false);
  });

  it('厳格モードの全ドメイン行に許可操作と状態クラスを表示する', () => {
    const blocked = inspector.createDomainItem(
      'app.example.com', { total: 1, types: { DOC: 1 } },
      true, false, true, false, false, false, false
    );
    expect(blocked.classList.contains('blocked')).toBe(true);
    expect(blocked.querySelector('.allow-btn')).not.toBeNull();

    inspector.domainRules = {
      'app.example.com': { action: 'allow', memo: '', tags: [] }
    };
    const allowed = inspector.createDomainItem(
      'app.example.com', { total: 1, types: { DOC: 1 } },
      true, true, false, false, false, false, false
    );
    expect(allowed.classList.contains('allowed')).toBe(true);
    expect(allowed.querySelector('.allow-btn.active')).not.toBeNull();
  });

  it('ルールのメモとタグをHTMLとして解釈しない', () => {
    const item = inspector.createRuleItem('example.com', {
      action: 'block',
      memo: '<img src=x onerror=alert(1)>',
      tags: ['"><svg onload=alert(1)>']
    });

    expect(item.querySelector('img')).toBeNull();
    expect(item.querySelector('svg[onload]')).toBeNull();
    expect(item.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(item.textContent).toContain('"><svg onload=alert(1)>');
  });

  it('通過・停止フィルタが厳格モードの許可状態を反映する', () => {
    inspector.domainData.mode = 'strict';
    inspector.domainData.allowed_domains = ['allowed.example'];
    inspector.domainRules = {
      'allowed.example': { action: 'allow', memo: '', tags: [] }
    };
    inspector.domainData.domain_counts = {
      'blocked.example': { total: 5, types: { XHR: 5 } },
      'allowed.example': { total: 2, types: { DOC: 2 } }
    };

    inspector.trafficFilter = 'blocked';
    expect(inspector.getSortedDomains().map(([domain]) => domain)).toEqual(['blocked.example']);

    inspector.trafficFilter = 'passing';
    expect(inspector.getSortedDomains().map(([domain]) => domain)).toEqual(['allowed.example']);
  });

  it('親ルールを継承し、より具体的な子ルールで上書きする', () => {
    inspector.domainRules = {
      'example.com': { action: 'block', memo: '', tags: [] },
      'api.example.com': { action: 'allow', memo: '', tags: [] }
    };

    expect(inspector.getEffectivePolicyRule('cdn.example.com')).toEqual({
      domain: 'example.com', action: 'block', inherited: true, source: 'global'
    });
    expect(inspector.isDomainEffectivelyBlocked('cdn.example.com')).toBe(true);
    expect(inspector.getEffectivePolicyRule('v1.api.example.com')).toEqual({
      domain: 'api.example.com', action: 'allow', inherited: true, source: 'global'
    });
    expect(inspector.isDomainEffectivelyBlocked('v1.api.example.com')).toBe(false);
  });

  it('親ルール継承を表示し、反対アクションから子ドメイン例外を作れる', () => {
    inspector.domainRules = {
      'example.com': { action: 'block', memo: '', tags: [] }
    };
    const item = inspector.createDomainItem(
      'cdn.example.com', { total: 2, types: { JS: 2 } },
      false, false, true, false, false, false, false
    );

    expect(item.textContent).toContain('親ルール');
    expect(item.querySelector('.block-btn.inherited').disabled).toBe(true);
    expect(item.querySelector('.allow-btn').disabled).toBe(false);
  });

  it('通信一覧・統計・ルールグループを実DOMへ描画する', () => {
    inspector.domainData = {
      domain_counts: {
        'app.example.com': { total: 3, types: { DOC: 1, XHR: 2 } },
        'ads.example.net': { total: 2, types: { JS: 2 } }
      },
      main_domain: 'app.example.com',
      blocked_domains: ['ads.example.net'],
      mode: 'strict',
      allowed_domains: ['app.example.com'],
      blocking_enabled: true,
      domain_rules: {},
      site_policy: {
        site_domain: 'example.com', enabled: false, rules: {}, temporary_allows: {}, precise_scope: true
      }
    };
    inspector.domainRules = {
      'app.example.com': { action: 'allow', memo: '本体', tags: ['core'] },
      'ads.example.net': { action: 'block', memo: '広告', tags: ['tracking'] }
    };
    inspector.expandedTags.add('core');

    inspector.render();

    const document = inspector.testDocument;
    expect(document.getElementById('currentSite').textContent).toBe('app.example.com');
    expect(document.getElementById('totalDomains').textContent).toBe('2');
    expect(document.getElementById('totalRequests').textContent).toBe('5');
    expect(document.querySelectorAll('.domain-item')).toHaveLength(2);
    expect(document.querySelector('[data-domain="app.example.com"]').classList.contains('allowed')).toBe(true);
    expect(document.querySelector('[data-domain="ads.example.net"]').classList.contains('blocked')).toBe(true);
    expect(document.querySelectorAll('.rules-group')).toHaveLength(2);
    expect(document.getElementById('rulesTabCount').textContent).toBe('2');
  });

  it('モード・全体停止・タブ表示をDOMへ同期する', () => {
    inspector.domainData.mode = 'strict';
    inspector.updateModeUI();
    const document = inspector.testDocument;
    expect(document.getElementById('modeToggle').checked).toBe(true);
    expect(document.querySelector('.container').classList.contains('strict-mode')).toBe(true);

    inspector.domainData.blocking_enabled = false;
    inspector.updateBlockingUI();
    expect(document.getElementById('blockingLabel').textContent).toBe('OFF');
    expect(document.getElementById('modeToggle').disabled).toBe(true);

    inspector.activeTab = 'rules';
    inspector.updateTabPanels();
    expect(document.getElementById('rulesPanel').classList.contains('active')).toBe(true);
    expect(document.getElementById('trafficPanel').classList.contains('active')).toBe(false);
  });

  it('厳格モードでは一括操作を許可リスト作成へ切り替える', async () => {
    inspector.domainData.mode = 'strict';
    inspector.domainData.domain_counts = {
      'app.example.com': { total: 1, types: { DOC: 1 } },
      'cdn.example.net': { total: 2, types: { JS: 2 } }
    };
    inspector.domainRules = {
      'app.example.com': { action: 'allow', memo: '', tags: [] }
    };
    inspector.confirmAction = async () => true;
    inspector.showToast = () => {};
    let sentMessage;
    inspector.request = async message => {
      sentMessage = message;
      return {
        success: true,
        blocked_domains: [],
        allowed_domains: ['app.example.com', 'cdn.example.net'],
        domain_rules: {
          ...inspector.domainRules,
          'cdn.example.net': { action: 'allow', memo: '', tags: [] }
        }
      };
    };

    inspector.updateBulkActions();
    const button = inspector.testDocument.getElementById('bulkBlockBtn');
    expect(button.textContent).toContain('表示中を許可');
    expect(button.classList.contains('bulk-allow')).toBe(true);

    await inspector.bulkPolicyAction();
    expect(sentMessage).toEqual({ type: 'BULK_ALLOW', domains: ['cdn.example.net'] });
  });

  it('現在サイトが親ルールから許可されていることをビルダーへ表示する', () => {
    inspector.domainRules = {
      'example.com': { action: 'allow', memo: '', tags: [] }
    };
    inspector.updatePolicyBuilder();

    const button = inspector.testDocument.getElementById('allowCurrentSiteBtn');
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('example.com から許可');
  });

  it('サイト専用ポリシーはサイト本体を通し、未登録の外部通信を停止する', () => {
    inspector.domainData.site_policy = {
      site_domain: 'example.com',
      enabled: true,
      rules: {
        'example.com': { action: 'allow', memo: 'サイト本体', tags: ['first-party'] }
      },
      temporary_allows: {},
      precise_scope: true
    };

    expect(inspector.getEffectivePolicyRule('app.example.com')).toMatchObject({
      domain: 'example.com', action: 'allow', source: 'site'
    });
    expect(inspector.isDomainEffectivelyBlocked('app.example.com')).toBe(false);
    expect(inspector.getEffectivePolicyRule('cdn.external.test')).toMatchObject({
      domain: 'example.com', action: 'block', source: 'site-default', defaultRule: true
    });
    expect(inspector.isDomainEffectivelyBlocked('cdn.external.test')).toBe(true);

    inspector.policyScope = 'site';
    const origin = inspector.createDomainItem(
      'app.example.com', { total: 1, types: { DOC: 1 } },
      true, true, false, false, false, false, false
    );
    expect(origin.querySelector('.allow-btn').disabled).toBe(true);
    expect(origin.querySelector('.block-btn').disabled).toBe(true);
    expect(origin.querySelector('.temporary-allow-btn').disabled).toBe(true);
  });

  it('編集範囲をこのサイトへ切り替え、サイト保護を開始できる', async () => {
    inspector.policyScope = 'site';
    inspector.showToast = () => {};
    let sentMessage;
    inspector.request = async message => {
      sentMessage = message;
      return {
        success: true,
        site_policy: {
          site_domain: 'example.com', enabled: true,
          rules: { 'example.com': { action: 'allow', memo: 'サイト本体', tags: ['first-party'] } },
          temporary_allows: {}, precise_scope: true
        }
      };
    };

    inspector.updatePolicyBuilder();
    expect(inspector.testDocument.querySelector('[data-policy-scope="site"]').classList.contains('active')).toBe(true);
    expect(inspector.testDocument.getElementById('allowCurrentSiteBtn').textContent).toContain('サイト保護を開始');

    await inspector.handlePolicyBuilderAction();
    expect(sentMessage).toEqual({ type: 'ENABLE_SITE_POLICY', siteDomain: 'example.com' });
    expect(inspector.domainData.site_policy.enabled).toBe(true);
  });

  it('サイト範囲の恒久ルールと5分許可を別々に操作する', async () => {
    inspector.policyScope = 'site';
    inspector.domainData.site_policy = {
      site_domain: 'example.com', enabled: true,
      rules: { 'tracker.test': { action: 'block', memo: '', tags: [] } },
      temporary_allows: {}, precise_scope: true
    };
    inspector.showToast = () => {};
    const messages = [];
    inspector.request = async message => {
      messages.push(message);
      if (message.type === 'TEMPORARILY_ALLOW_SITE_DOMAIN') {
        return {
          success: true,
          site_policy: {
            ...inspector.domainData.site_policy,
            temporary_allows: { 'tracker.test': Date.now() + 300_000 }
          }
        };
      }
      return {
        success: true,
        site_policy: { ...inspector.domainData.site_policy, rules: {} }
      };
    };

    await inspector.toggleBlock('tracker.test');
    expect(messages[0]).toEqual({
      type: 'DELETE_SITE_RULE', siteDomain: 'example.com', domain: 'tracker.test'
    });

    inspector.domainData.site_policy.rules = {
      'tracker.test': { action: 'block', memo: '', tags: [] }
    };
    await inspector.toggleTemporaryAllow('tracker.test');
    expect(messages[1]).toEqual({
      type: 'TEMPORARILY_ALLOW_SITE_DOMAIN', siteDomain: 'example.com', domain: 'tracker.test'
    });

    const item = inspector.createDomainItem(
      'tracker.test', { total: 1, types: { XHR: 1 } },
      true, true, false, false, false, true, false
    );
    expect(item.textContent).toContain('一時');
    expect(item.querySelector('.temporary-allow-btn.active')).not.toBeNull();
  });

  it('サイト範囲の一括許可は他サイトに影響しないメッセージを送る', async () => {
    inspector.policyScope = 'site';
    inspector.domainData.site_policy = {
      site_domain: 'example.com', enabled: true,
      rules: { 'example.com': { action: 'allow', memo: '', tags: [] } },
      temporary_allows: {}, precise_scope: true
    };
    inspector.domainData.domain_counts = {
      'app.example.com': { total: 1, types: { DOC: 1 } },
      'cdn.external.test': { total: 2, types: { JS: 2 } }
    };
    inspector.confirmAction = async () => true;
    inspector.showToast = () => {};
    let sentMessage;
    inspector.request = async message => {
      sentMessage = message;
      return { success: true, site_policy: inspector.domainData.site_policy };
    };

    await inspector.bulkPolicyAction();
    expect(sentMessage).toEqual({
      type: 'BULK_ALLOW_SITE_DOMAINS',
      siteDomain: 'example.com',
      domains: ['cdn.external.test']
    });
  });

  it('ルールグループを開閉し、一括選択できる', () => {
    inspector.domainRules = {
      'one.example': { action: 'block', memo: '', tags: ['group'] },
      'two.example': { action: 'allow', memo: '', tags: ['group'] }
    };
    const group = inspector.createRulesGroup('group', [
      { domain: 'one.example', rule: inspector.domainRules['one.example'] },
      { domain: 'two.example', rule: inspector.domainRules['two.example'] }
    ]);
    inspector.testDocument.body.appendChild(group);

    group.querySelector('.rules-group-toggle').click();
    expect(group.classList.contains('expanded')).toBe(true);

    const checkbox = group.querySelector('.rules-group-checkbox');
    checkbox.checked = true;
    checkbox.dispatchEvent(new inspector.testWindow.Event('change', { bubbles: true }));
    expect([...inspector.selectedRules].sort()).toEqual(['one.example', 'two.example']);
    expect(group.querySelectorAll('.rule-item.selected')).toHaveLength(2);
  });

  it('初期ロード、タブ切替、更新通知、カウントクリアを実DOMで処理する', async () => {
    const window = inspector.testWindow;
    const document = inspector.testDocument;
    const DomainTrafficInspector = inspector.testClass;
    let runtimeListener;
    let activatedListener;
    const sentMessages = [];
    const initialState = {
      domain_counts: {
        'api.example.com': { total: 2, types: { XHR: 2 } }
      },
      main_domain: 'app.example.com',
      blocked_domains: [],
      mode: 'normal',
      allowed_domains: [],
      blocking_enabled: true,
      domain_rules: {
        'api.example.com': { action: 'allow', memo: '', tags: [] }
      },
      site_policy: {
        site_domain: 'example.com', enabled: false, rules: {}, temporary_allows: {}, precise_scope: true
      }
    };

    window.chrome = {
      tabs: {
        async query() { return [{ id: 9, windowId: 3 }]; },
        onActivated: { addListener(listener) { activatedListener = listener; } }
      },
      runtime: {
        onMessage: { addListener(listener) { runtimeListener = listener; } },
        async sendMessage(message) {
          sentMessages.push(message);
          if (message.type === 'GET_TAB_DATA') return structuredClone(initialState);
          if (message.type === 'CLEAR_COUNTS') return { success: true };
          throw new Error(`Unexpected message: ${message.type}`);
        }
      }
    };

    const initialized = new DomainTrafficInspector();
    await initialized.ready;

    expect(initialized.currentTabId).toBe(9);
    expect(initialized.currentWindowId).toBe(3);
    expect(document.querySelectorAll('.domain-item')).toHaveLength(1);
    expect(document.getElementById('currentSite').textContent).toBe('app.example.com');

    document.getElementById('rulesTab').click();
    expect(initialized.activeTab).toBe('rules');
    expect(document.getElementById('rulesPanel').classList.contains('active')).toBe(true);

    runtimeListener({
      type: 'UPDATE_COUNTS',
      tabId: 9,
      data: {
        ...structuredClone(initialState),
        domain_counts: {
          'api.example.com': { total: 4, types: { XHR: 4 } }
        }
      }
    });
    expect(initialized.domainData.domain_counts['api.example.com'].total).toBe(4);

    await initialized.clearCounts();
    expect(initialized.domainData.domain_counts).toEqual({});
    expect(sentMessages.some(message => message.type === 'CLEAR_COUNTS')).toBe(true);

    await activatedListener({ tabId: 10, windowId: 4 });
    expect(initialized.currentTabId).toBe(9);
    await activatedListener({ tabId: 10, windowId: 3 });
    expect(initialized.currentTabId).toBe(10);
  });

  it('インポートデータを正規化し、危険なキーを拒否する', () => {
    const rules = inspector.validateImportData({
      version: 1,
      rules: {
        'EXAMPLE.COM.': {
          action: 'allow',
          memo: ' memo ',
          tags: [' trusted ', 'trusted']
        }
      }
    });
    expect(rules['example.com']).toEqual({
      action: 'allow', memo: 'memo', tags: ['trusted']
    });

    const dangerous = JSON.parse('{"version":1,"rules":{"__proto__":{"action":"allow"}}}');
    expect(() => inspector.validateImportData(dangerous)).toThrow('無効なドメイン');
  });

  it('壊れたインポート形式と上限超過を拒否する', () => {
    expect(() => inspector.validateImportData({ version: 2, rules: {} }))
      .toThrow('version: 1');
    expect(() => inspector.validateImportData({
      version: 1,
      rules: { 'example.com': { action: 'allow', memo: 'x'.repeat(501) } }
    })).toThrow('memo は500文字以内');
    expect(() => inspector.validateImportData({
      version: 1,
      rules: { 'example.com': { action: 'allow', tags: [''] } }
    })).toThrow('tags は1〜32文字');
  });
});
