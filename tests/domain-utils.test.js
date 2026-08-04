import { describe, it, expect } from 'vitest';

const {
  getDomainRoot,
  extractDomain,
  normalizeDomain,
  isValidDomain,
  getShortType,
  isLikelyAd,
  isLikelySafe,
  isThirdParty,
  AD_PART_KEYWORDS,
  CC_TLDS
} = require('../lib/domain-utils.js');

// =============================================
// getDomainRoot
// =============================================
describe('getDomainRoot', () => {
  it('通常の2パーツドメインはそのまま返す', () => {
    expect(getDomainRoot('example.com')).toBe('example.com');
    expect(getDomainRoot('google.com')).toBe('google.com');
  });

  it('サブドメイン付きは登録ドメインを返す', () => {
    expect(getDomainRoot('www.example.com')).toBe('example.com');
    expect(getDomainRoot('cdn.assets.example.com')).toBe('example.com');
  });

  it('ccTLD (.co.jp等) は3パーツ返す', () => {
    expect(getDomainRoot('google.co.jp')).toBe('google.co.jp');
    expect(getDomainRoot('www.google.co.jp')).toBe('google.co.jp');
    expect(getDomainRoot('bbc.co.uk')).toBe('bbc.co.uk');
    expect(getDomainRoot('cdn.bbc.co.uk')).toBe('bbc.co.uk');
  });

  it('ccTLD以外の2パーツTLDは通常扱い', () => {
    expect(getDomainRoot('example.org')).toBe('example.org');
    expect(getDomainRoot('sub.example.org')).toBe('example.org');
  });

  it('プライベートサフィックスはテナント単位で返す', () => {
    expect(getDomainRoot('alice.github.io')).toBe('alice.github.io');
    expect(getDomainRoot('app.example.pages.dev')).toBe('example.pages.dev');
  });

  it('1パーツドメインはそのまま返す', () => {
    expect(getDomainRoot('localhost')).toBe('localhost');
  });

  it('IPアドレスをドメインのように切り詰めない', () => {
    expect(getDomainRoot('192.168.0.1')).toBe('192.168.0.1');
    expect(isThirdParty('192.168.0.1', '10.0.0.1')).toBe(true);
  });
});

describe('normalizeDomain', () => {
  it('大文字・末尾ドット・国際化ドメインを正規化する', () => {
    expect(normalizeDomain(' Example.COM. ')).toBe('example.com');
    expect(normalizeDomain('例え.テスト')).toBe('xn--r8jz45g.xn--zckzah');
  });

  it('URLや危険なプロパティ名を拒否する', () => {
    expect(normalizeDomain('https://example.com')).toBeNull();
    expect(normalizeDomain('example.com/path')).toBeNull();
    expect(normalizeDomain('__proto__')).toBeNull();
    expect(isValidDomain('example.com')).toBe(true);
    expect(isValidDomain('-invalid.example')).toBe(false);
  });
});

// =============================================
// extractDomain
// =============================================
describe('extractDomain', () => {
  it('HTTPSのURLからドメインを抽出', () => {
    expect(extractDomain('https://www.example.com/path')).toBe('www.example.com');
  });

  it('HTTPのURLからドメインを抽出', () => {
    expect(extractDomain('http://api.example.com:8080/v1')).toBe('api.example.com');
  });

  it('無効なURLはnullを返す', () => {
    expect(extractDomain('not-a-url')).toBeNull();
    expect(extractDomain('')).toBeNull();
  });
});

// =============================================
// getShortType
// =============================================
describe('getShortType', () => {
  it('既知のリソースタイプを短縮名に変換', () => {
    expect(getShortType('script')).toBe('JS');
    expect(getShortType('stylesheet')).toBe('CSS');
    expect(getShortType('image')).toBe('IMG');
    expect(getShortType('xmlhttprequest')).toBe('XHR');
    expect(getShortType('font')).toBe('FONT');
    expect(getShortType('websocket')).toBe('WS');
    expect(getShortType('main_frame')).toBe('DOC');
    expect(getShortType('sub_frame')).toBe('FRAME');
  });

  it('未知のタイプはOTHERを返す', () => {
    expect(getShortType('unknown')).toBe('OTHER');
    expect(getShortType('')).toBe('OTHER');
  });
});

// =============================================
// isLikelyAd
// =============================================
describe('isLikelyAd', () => {
  describe('広告ドメインを正しく検出', () => {
    it('ドメインパーツに広告キーワードが含まれる場合', () => {
      expect(isLikelyAd('ad.doubleclick.net')).toBe(true);
      expect(isLikelyAd('tracker.example.com')).toBe(true);
      expect(isLikelyAd('analytics.google.com')).toBe(true);
      expect(isLikelyAd('pixel.facebook.com')).toBe(true);
      expect(isLikelyAd('beacon.example.com')).toBe(true);
    });

    it('既知の広告ドメインパターンにマッチ', () => {
      expect(isLikelyAd('pagead2.googlesyndication.com')).toBe(true);
      expect(isLikelyAd('stats.criteo.com')).toBe(true);
      expect(isLikelyAd('cdn.taboola.com')).toBe(true);
      expect(isLikelyAd('widgets.outbrain.com')).toBe(true);
      expect(isLikelyAd('s.amazon-adsystem.com')).toBe(true);
    });
  });

  describe('一般ドメインを誤検知しない', () => {
    it('adを含むが広告でないドメイン', () => {
      expect(isLikelyAd('adobe.com')).toBe(false);
      expect(isLikelyAd('adidas.com')).toBe(false);
      expect(isLikelyAd('loading.example.com')).toBe(false);
    });

    it('trackを含むが広告でないドメイン', () => {
      expect(isLikelyAd('soundtrack.com')).toBe(false);
      expect(isLikelyAd('racetrack.io')).toBe(false);
    });

    it('syncを含むが広告でないドメイン', () => {
      expect(isLikelyAd('syncthing.net')).toBe(false);
    });

    it('通常のドメイン', () => {
      expect(isLikelyAd('google.com')).toBe(false);
      expect(isLikelyAd('github.com')).toBe(false);
      expect(isLikelyAd('stackoverflow.com')).toBe(false);
    });
  });
});

// =============================================
// isLikelySafe
// =============================================
describe('isLikelySafe', () => {
  it('CDN/ライブラリドメインを検出', () => {
    expect(isLikelySafe('fonts.googleapis.com')).toBe(true);
    expect(isLikelySafe('cdn.jsdelivr.net')).toBe(true);
    expect(isLikelySafe('cdnjs.cloudflare.com')).toBe(true);
    expect(isLikelySafe('d1234.cloudfront.net')).toBe(true);
  });

  it('一般ドメインは安全判定しない', () => {
    expect(isLikelySafe('example.com')).toBe(false);
    expect(isLikelySafe('evil.com')).toBe(false);
    expect(isLikelySafe('notjquery-malware.example')).toBe(false);
    expect(isLikelySafe('cdn.jsdelivr.net.evil.example')).toBe(false);
  });
});

// =============================================
// isThirdParty
// =============================================
describe('isThirdParty', () => {
  it('同一ドメインはサードパーティでない', () => {
    expect(isThirdParty('example.com', 'example.com')).toBe(false);
  });

  it('サブドメインはサードパーティでない', () => {
    expect(isThirdParty('cdn.example.com', 'example.com')).toBe(false);
    expect(isThirdParty('api.cdn.example.com', 'example.com')).toBe(false);
  });

  it('異なるドメインはサードパーティ', () => {
    expect(isThirdParty('google.com', 'example.com')).toBe(true);
    expect(isThirdParty('cdn.google.com', 'example.com')).toBe(true);
  });

  it('ccTLDドメインの同一判定が正しい', () => {
    expect(isThirdParty('cdn.example.co.jp', 'example.co.jp')).toBe(false);
    expect(isThirdParty('other.co.jp', 'example.co.jp')).toBe(true);
  });

  it('プライベートサフィックス上の別テナントをサードパーティ扱いする', () => {
    expect(isThirdParty('alice.github.io', 'bob.github.io')).toBe(true);
    expect(isThirdParty('alice.pages.dev', 'bob.pages.dev')).toBe(true);
  });

  it('mainDomainがnullならfalse', () => {
    expect(isThirdParty('example.com', null)).toBe(false);
  });
});

// =============================================
// 定数の整合性チェック
// =============================================
describe('定数', () => {
  it('AD_PART_KEYWORDS はSetである', () => {
    expect(AD_PART_KEYWORDS).toBeInstanceOf(Set);
    expect(AD_PART_KEYWORDS.size).toBeGreaterThan(0);
  });

  it('CC_TLDS はSetである', () => {
    expect(CC_TLDS).toBeInstanceOf(Set);
    expect(CC_TLDS.has('co.jp')).toBe(true);
    expect(CC_TLDS.has('co.uk')).toBe(true);
  });
});
