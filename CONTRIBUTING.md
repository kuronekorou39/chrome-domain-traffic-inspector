# Contributing

IssueやPull Requestによる改善提案を歓迎します。

## 開発環境

Node.js 22.13以降を使用します。

```sh
npm ci
npm run lint
npm run test:coverage
```

Chromeで確認する場合は `chrome://extensions` のデベロッパーモードから、このリポジトリをパッケージ化されていない拡張機能として読み込んでください。リリースに関わる変更では [SMOKE_TEST.md](SMOKE_TEST.md) も確認します。

## Pull Request

- 変更理由を説明し、関連するIssueがあればリンクしてください。
- 挙動を変える修正には、失敗を再現して修正後に通るテストを追加してください。
- Chrome権限やデータ取扱いを変える場合は、READMEとPRIVACYも更新してください。
- 一つのPull Requestには関連する変更だけを含めてください。

## セキュリティ

悪用可能な脆弱性は公開Issueへ投稿せず、[Security Policy](SECURITY.md)に従って非公開で報告してください。

