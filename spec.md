Spec: Domain Traffic Inspector
1. 目的
特定のタブから発生する通信をドメイン単位で可視化し、個別にブロック制御を行う。

2. 機能要件
監視: アクティブなタブの全リクエストからドメインを抽出。

集計: ドメインごとのリクエスト数をリアルタイムにカウント。

制御: ドメイン単位での通信ブロック（ON/OFF）機能。

UI: 拡張機能ポップアップ内に「ドメイン名 | 件数 | ブロックボタン」のテーブルを表示。

3. 技術仕様
Manifest: V3

API: webRequest, webRequestBlocking (または declarativeNetRequest), storage

権限: host_permissions: ["<all_urls>"]

構成:

background.js: 通信のインターセプト、集計データ管理、ブロックロジック。

popup.html/js: 集計データの表示およびブロック操作の通信。

4. データ構造
JSON
{
  "tabData": {
    "tabId": {
      "domain_counts": { "example.com": 12, "api.test.jp": 5 },
      "blocked_domains": ["ads.tracking.com"]
    }
  }
}