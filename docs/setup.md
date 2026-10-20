# 本番の下準備（ユーザーの作業）

本番（`https://calendar.ataraman.com`）に出す前に、Cloudflare・Google・GitHub で一度だけ行う設定です。Claude はこれらのアカウントを操作できないので、ユーザーが行います。どの実装の前に必要かは [ロードマップ 2章](ROADMAP.md#2-下準備ユーザーの作業) を参照してください。

作業の途中で出てくる値のうち、**Claude に伝える値**は「5. Claude に伝える」にまとめてあります。**秘密の値（Client Secret・API トークン）は、Claude にもチャットにも貼らないでください。**

## 順番

1. D1 のデータベースを作る（1）
2. Google ログインを Access に登録する（2）
3. Access のアプリを作る（3）
4. API トークンを作り、GitHub に Secret を登録する（4）
5. 3つの値を Claude に伝える → Claude が PR を出してマージする（5）
6. GitHub に `DEPLOY_ENABLED` を入れて、最初のデプロイを動かす（6）
7. 許可するメールアドレスを Worker に登録する（7）

---

## 1. D1 のデータベースを作る

1. Cloudflare のダッシュボードで、**Storage & Databases → D1 SQL database → Create** を開く。
2. 名前を `atara-calendar` にして作成する（場所の指定は、選べるなら「Asia-Pacific」）。
   - **Why 名前を揃えるのか**: `wrangler.jsonc` とデプロイの手順が、この名前でデータベースを探すからです。
3. 作成後の画面に出る **Database ID**（`xxxxxxxx-xxxx-...` の形）を控える。→ Claude に伝える値

## 2. Google ログインを Access に登録する

### 2.1 チーム名を確かめる

1. Cloudflare のダッシュボードで **Zero Trust** を開く（初めてなら、Free プランで始める）。
2. **Settings → Team name and domain** で、チームのドメイン（`<チーム名>.cloudflareaccess.com`）を控える。→ Claude に伝える値

### 2.2 Google の OAuth クライアントを作る

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを1つ作る（既存のものでもよい）。
2. **API とサービス → OAuth 同意画面** を設定する（ユーザーの種類は「外部」、アプリ名は `atara-calendar` など）。
   - テストユーザーに、自分の Gmail アドレスを追加する。
3. **API とサービス → 認証情報 → 認証情報を作成 → OAuth クライアント ID** で、種類を「ウェブ アプリケーション」にして、次を入れる。
   - 承認済みの JavaScript 生成元: `https://<チーム名>.cloudflareaccess.com`
   - 承認済みのリダイレクト URI: `https://<チーム名>.cloudflareaccess.com/cdn-cgi/access/callback`
   - **Why**: Google でログインした後、Access のこの URL に戻ってくるからです。1文字でも違うと「redirect_uri_mismatch」のエラーになります。
4. 表示される **クライアント ID** と **クライアント シークレット** を控える（シークレットは秘密。Claude に伝えない）。

### 2.3 Access に Google を登録する

1. Zero Trust の **Integrations → Identity providers**（画面によっては **Settings → Authentication**）で、**Add new → Google** を選ぶ。
2. App ID にクライアント ID、Client secret にクライアント シークレットを入れて保存する。
3. 一覧の Google の横にある **Test** で、自分の Google アカウントでログインできることを確かめる。

## 3. Access のアプリを作る

1. Zero Trust の **Access → Applications → Add an application → Self-hosted** を選ぶ。
2. 次のように設定する。

   | 項目 | 設定 |
   | --- | --- |
   | アプリ名 | `atara-calendar` |
   | ドメイン | `calendar.ataraman.com`（パスは空のまま。サイト全体を守る） |
   | セッションの長さ（Session Duration） | **1 month**（要件 AU-2） |
   | ログイン方法（Identity providers） | Google だけにする。可能なら「Instant Auth」を ON（選択画面を飛ばして Google に進む） |

3. ポリシーを1つ作る。
   - Action: **Allow**
   - Include: **Emails** に、自分の Gmail アドレスを1つだけ入れる（要件 AU-1）
4. 保存した後、アプリの概要（Overview）にある **Application Audience (AUD) Tag** を控える。→ Claude に伝える値
   - **Why**: Worker は、Access が付けたログイン情報（JWT）がこのアプリ宛てかどうかを、この値で確かめます（[設計書 10.2](design/design.md#102-worker-側の確認二重の守り)）。

## 4. GitHub から自動でデプロイできるようにする

### 4.1 Cloudflare の API トークンを作る

1. Cloudflare のダッシュボードの右上 **プロフィール → API Tokens → Create Token** を開く。
2. テンプレート **「Edit Cloudflare Workers」** を選び、権限に **Account → D1 → Edit** を足す。
   - Account Resources: 自分のアカウント
   - Zone Resources: `ataraman.com`
   - **Why D1 を足すのか**: デプロイのたびに、テーブルの変更（マイグレーション）を本番の D1 に当てるからです。
3. 作成されたトークンを控える（秘密。Claude に伝えない。画面を閉じると二度と表示されない）。
4. ダッシュボードの右側などに出る **Account ID** を控える。

### 4.2 GitHub に登録する

リポジトリ `atara-327/atara-calendar` の **Settings → Secrets and variables → Actions** で、次を登録する。

| 種類 | 名前 | 値 |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | 4.1 のトークン |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | 4.1 の Account ID |

`DEPLOY_ENABLED` は、ここではまだ入れません（6 で入れます）。

## 5. Claude に伝える

次の3つは秘密ではないので、チャットで Claude に伝えてください。Claude が `wrangler.jsonc` に入れて PR を出します。

| 値 | 例 | どこで控えたか |
| --- | --- | --- |
| D1 の Database ID | `12345678-90ab-...` | 1 |
| チームのドメイン | `xxxx.cloudflareaccess.com` | 2.1 |
| Access の AUD タグ | 長い英数字 | 3 |

## 6. 最初のデプロイを動かす

5 の PR がマージされた後に行います。

1. 4.2 と同じ画面の **Variables** タブで、`DEPLOY_ENABLED` に `true` を登録する。
   - **Why PR のマージの後なのか**: これを `true` にした時点から、main に取り込むたびに本番へ自動でデプロイされるからです。本番用の値（5）が `wrangler.jsonc` に入る前に動くと、デプロイが失敗します。
2. リポジトリの **Actions → CI → Run workflow** で、main を選んで実行する（Claude に頼んでもよい）。
   - `calendar.ataraman.com` に、すでに DNS のレコード（CNAME など）があると、デプロイが失敗します。その場合は、Cloudflare の **DNS → Records** でそのレコードを消してからやり直してください。
   - **Why**: Worker の Custom Domain は、DNS のレコードと証明書を Cloudflare が自動で作るので、同じ名前の既存のレコードとぶつかるからです。
3. 「deploy」が成功したら、Cloudflare に Worker `atara-calendar` ができ、`https://calendar.ataraman.com` で画面が開けるようになる（Google でのログインを求められる）。

## 7. 許可するメールアドレスを Worker に登録する

1. ダッシュボードの **Workers & Pages → atara-calendar → Settings → Variables and Secrets** を開く。
2. **Add → Secret** で、名前 `ALLOWED_EMAIL`、値に自分の Gmail アドレス（3 のポリシーと同じもの）を入れて保存する。
   - **Why Secret にするのか**: リポジトリにメールアドレスを残さないためです（[設計書 10.4](design/design.md#104-秘密情報nf-3)）。
   - この登録までは、画面は開けても API がすべて拒否されます（設定漏れで素通りしないための動き）。
   - **Why 最初のデプロイの後なのか**: Worker が Cloudflare にできてからでないと、Secret を登録する場所がないからです。

## 8. あると安心な設定（任意）

- Cloudflare の **SSL/TLS → Edge Certificates** で、**Always Use HTTPS** と **HSTS** を ON にする。
  - **Why**: `http://` で開いたときも必ず暗号化された通信になり、通信の途中での書き換えを防げるからです。
