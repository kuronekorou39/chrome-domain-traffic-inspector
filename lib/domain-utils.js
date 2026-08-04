// Domain Traffic Inspector - 共有ドメインユーティリティ
// background.js と sidepanel.js の両方で使用するロジック

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

// よく使われる複合サフィックス。
// 完全な Public Suffix List ではないため、判定結果は UI 上で「推定」として扱う。
const CC_TLDS = new Set([
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.uk', 'org.uk', 'ac.uk',
  'co.kr', 'or.kr', 'co.in', 'co.id',
  'com.au', 'com.br', 'com.cn', 'com.tw', 'com.hk',
  'com.sg', 'com.mx', 'com.ar', 'co.za', 'co.nz',
  'com.tr', 'com.pl', 'com.ua', 'com.my', 'com.ph', 'com.vn'
]);

// テナントごとに別サイトとして扱う代表的なプライベートサフィックス。
const PRIVATE_SUFFIXES = new Set([
  'github.io', 'pages.dev', 'appspot.com', 'vercel.app',
  'netlify.app', 'workers.dev', 'web.app', 'firebaseapp.com'
]);

// 既知の CDN/ライブラリ配信元。部分一致ではなくドメイン境界で照合する。
const SAFE_DOMAIN_SUFFIXES = [
  'fonts.googleapis.com', 'fonts.gstatic.com',
  'ajax.googleapis.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com',
  'unpkg.com', 'stackpathcdn.com', 'cloudfront.net',
  'akamaihd.net', 'fastly.net'
];

// 後方互換: 既存テストや利用コード向けの別名。
const SAFE_KEYWORDS = SAFE_DOMAIN_SUFFIXES;

// リソースタイプの短縮名マッピング
const TYPE_MAP = {
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

// ドメインの登録ドメイン部分を取得（ccTLD対応）
function getDomainRoot(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return domain;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) || normalized.startsWith('[')) {
    return normalized;
  }
  const parts = normalized.split('.');
  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join('.');
    if (CC_TLDS.has(lastTwo) || PRIVATE_SUFFIXES.has(lastTwo)) {
      return parts.slice(-3).join('.');
    }
  }
  return parts.length >= 2 ? parts.slice(-2).join('.') : normalized;
}

// URLからドメインを抽出
function extractDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return null;
  }
}

// ユーザー入力を DNR の requestDomains に渡せるホスト名へ正規化する。
function normalizeDomain(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim().toLowerCase().replace(/\.$/, '');
  if (!input || input.length > 253 || /[\s/?#@]/.test(input)) return null;
  if (input.includes(':') && !(input.startsWith('[') && input.endsWith(']'))) return null;
  if (input === '__proto__' || input === 'prototype' || input === 'constructor') return null;

  try {
    const parsed = new URL(`http://${input}`);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!hostname || parsed.port || parsed.username || parsed.password) return null;

    // URL パーサーが入力の一部だけをホスト名として解釈するケースを拒否する。
    if (hostname !== input && !/[^\x00-\x7F]/.test(input)) return null;

    // IPv6 は URL.hostname が角括弧付きで返る。
    if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname;
    if (hostname.includes(':')) return null;

    const labels = hostname.split('.');
    if (!labels.every(label =>
      label.length >= 1 && label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    )) return null;
    return hostname;
  } catch {
    return null;
  }
}

function isValidDomain(value) {
  return normalizeDomain(value) !== null;
}

// リソースタイプを短縮形に変換
function getShortType(type) {
  return TYPE_MAP[type] || 'OTHER';
}

// ドメインが広告/トラッキングの可能性があるか判定
function isLikelyAd(domain) {
  const lowerDomain = domain.toLowerCase();
  const parts = lowerDomain.split('.');
  if (parts.some(part => AD_PART_KEYWORDS.has(part))) return true;
  return AD_DOMAIN_PATTERNS.some(pattern => lowerDomain.includes(pattern));
}

// ドメインが安全（CDN等）か判定
function isLikelySafe(domain) {
  const lowerDomain = domain.toLowerCase();
  return SAFE_DOMAIN_SUFFIXES.some(suffix =>
    lowerDomain === suffix || lowerDomain.endsWith('.' + suffix)
  );
}

// サードパーティか判定
function isThirdParty(domain, mainDomain) {
  if (!mainDomain) return false;
  if (domain === mainDomain) return false;
  if (domain.endsWith('.' + mainDomain) || mainDomain.endsWith('.' + domain)) return false;
  return getDomainRoot(domain) !== getDomainRoot(mainDomain);
}

// Node.js (テスト用) / ブラウザ 両対応のエクスポート
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AD_PART_KEYWORDS,
    AD_DOMAIN_PATTERNS,
    CC_TLDS,
    PRIVATE_SUFFIXES,
    SAFE_DOMAIN_SUFFIXES,
    SAFE_KEYWORDS,
    TYPE_MAP,
    getDomainRoot,
    extractDomain,
    normalizeDomain,
    isValidDomain,
    getShortType,
    isLikelyAd,
    isLikelySafe,
    isThirdParty
  };
}
