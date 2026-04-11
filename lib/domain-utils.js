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

// ccTLD（国別コードTLD + 汎用サブTLD）
const CC_TLDS = new Set([
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.uk', 'org.uk', 'ac.uk',
  'co.kr', 'or.kr', 'co.in', 'co.id',
  'com.au', 'com.br', 'com.cn', 'com.tw', 'com.hk',
  'com.sg', 'com.mx', 'com.ar', 'co.za', 'co.nz'
]);

// 安全なドメイン判定用（部分一致）
const SAFE_KEYWORDS = [
  'fonts.googleapis', 'fonts.gstatic',
  'ajax.googleapis', 'cdn.jsdelivr', 'cdnjs.cloudflare',
  'unpkg.com', 'stackpath', 'cloudfront.net',
  'akamaihd.net', 'fastly.net',
  'jquery', 'bootstrap', 'fontawesome'
];

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
  const parts = domain.split('.');
  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join('.');
    if (CC_TLDS.has(lastTwo)) {
      return parts.slice(-3).join('.');
    }
  }
  return parts.length >= 2 ? parts.slice(-2).join('.') : domain;
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
  return SAFE_KEYWORDS.some(keyword => lowerDomain.includes(keyword));
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
    SAFE_KEYWORDS,
    TYPE_MAP,
    getDomainRoot,
    extractDomain,
    getShortType,
    isLikelyAd,
    isLikelySafe,
    isThirdParty
  };
}
