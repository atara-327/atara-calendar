# atara-calendar

自分専用のカレンダーアプリ。月でページを区切らない**無限スクロールの月表示**と、1日の時間割を立てる**日表示**が中心。
Cloudflare（Workers + D1 + Access）に載せ、通知は Discord に送る。

- 要件: [docs/requirements/requirements.md](docs/requirements/requirements.md)（何を作るか）
- 設計: [docs/design/design.md](docs/design/design.md)（どう作るか）
- 後でやること: [docs/BACKLOG.md](docs/BACKLOG.md)

設計書に書いていないことを実装で決める必要が出たら、勝手に決めずにユーザーに確認する。決めた内容は設計書に追記する。

## やり取りのルール

- 説明・決定・判断には、必ず **Why**（なぜそうするのか）を書く。
- 情報が足りないときは推測で進めず、質問して情報を集めてから答える。
- ユーザーとのやり取りは日本語で行う。

## 役割分担（メインセッションとサブエージェント）

- **メインセッション**: 相談・要件・設計・レビューの判断を担当する。「何を作るか・どう作るか」を決め、実装結果を確認する。
- **implementer**（`.claude/agents/implementer.md`。実装用の軽いモデルで動く）: コードの実装・雛形作り・テストの追加・機械的な修正など、手を動かす作業を担当する。
- **reviewer**（`.claude/agents/reviewer.md`。メインと同じモデルで、読み取り専用）: マージ前のレビューを担当する。

実装は implementer に任せ、メインセッションは設計とレビューに集中する。
ただし、**繰り返しの展開・祝日の計算・同期**は間違えやすく、後から直しにくい中核部分である。そのため、メインセッションが実装方針を具体的に指示し、レビューも重点的に行う。

> 実際に動くモデルは、ユーザーが `/model` で選ぶ。ここに書いてあるのは、このプロジェクトでの使い分けの申し合わせ。

## 技術スタック

設計書の2章が正式な一覧。要点は次のとおり。

- **言語**: TypeScript（画面・Worker の両方）
- **画面**: React + Vite / TanStack Virtual / Zustand / wouter / CSS Modules
- **API・定期実行**: Cloudflare Workers + Hono（Worker は1個）
- **DB**: Cloudflare D1。SQL を直接書く（ORM は使わない）。変更は `migrations/` で管理する
- **認証**: Cloudflare Access（Google ログイン）＋ Worker 側での JWT 検証（jose）
- **入力チェック**: Zod
- **テスト**: Vitest
- **静的チェック**: ESLint + Prettier
- **パッケージマネージャ**: npm

## ディレクトリ構成

```
src/shared/   画面と Worker の両方で使うコード（日付・祝日・繰り返し・通知時刻・スキーマ）
src/worker/   Cloudflare Worker（API・認証・定期実行）
src/client/   画面（React）
migrations/   D1 のテーブル定義
test/fixtures/ テストの正解データ（内閣府の祝日一覧など）
```

## 開発の決まりごと

### コード

- 型は厳しく扱う。`any` は使わない。型は Zod のスキーマから導く（`z.infer`）。
- 日付と時刻は、日本時間の文字列（`"2026-10-19"`、`"15:00"`）で扱う。ブラウザの `Date` を、端末のタイムゾーンのまま使わない（設計書2章）。
- 画面と Worker の両方で必要なロジックは、必ず `src/shared/` に置き、1つのコードを共有する。
- 実装する前に、周りのコードの流儀（命名・コメントの量・書き方）を読んで合わせる。

### 秘密情報

- Discord の Webhook URL や、許可するメールアドレスはコミットしない。本番は Cloudflare の Secrets、手元の開発は `.dev.vars`（`.gitignore` 済み）に置く。

### 何をどこに書くか（t-wada 原則）

- **コード**には How（どう動くか）
- **テストコード**には What（何をするか＝仕様）
- **コミットログ**には Why（なぜその変更をしたか）
- **コードコメント**には Why not（なぜ別のやり方にしなかったか）

### PR とコミット

- **PR は機能ごとに分ける**。1つの PR には、1つの意味のまとまり（1機能・1目的）だけを入れる。
- **コミットは、1つの論理的な変更ごとに分ける**。無関係な変更を混ぜない。壊れた状態のコミットも作らない。
- push する前に、型チェック（`npx tsc --noEmit`）・Lint・テスト（`npm test`）を通す。
- main に取り込まれたら本番に反映される（設計書 Q7）。そのため、マージはメインセッションが reviewer の報告をもとに判断し、**ユーザーの了承を得てから** Squash マージする。
