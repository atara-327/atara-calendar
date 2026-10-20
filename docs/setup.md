# 本番の下準備（ユーザーの作業）

本番（`https://calendar.ataraman.com`）に出す前に、Cloudflare・Google・GitHub で一度だけ行う設定です。Claude はこれらのアカウントを操作できないので、ユーザーが行います。どの実装の前に必要かは [ロードマップ 2章](ROADMAP.md#2-下準備ユーザーの作業) を参照してください。

作業の途中で出てくる値のうち、**Claude に伝える値**は「5. Claude に伝える」にまとめてあります。**秘密の値（Client Secret・API トークン）は、Claude にもチャットにも貼らないでください。**

## 順番

1. D1 のデータベースを作る（1）
2. Google ログインを Access に登録する（2）
3. Access のアプリを作る（3）
4. API トークンを作り、GitHub の環境 `production` に Secret を登録する（4）
5. 3つの値を Claude に伝える → Claude が PR を出してマージする（5）
6. GitHub に `DEPLOY_ENABLED` を入れて、最初のデプロイを動かす（6）
7. 許可するメールアドレスを Worker に登録する（7）
8. 動作を確認する（8）

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
2. **API とサービス → OAuth 同意画面** を設定する（ユーザーの種類は「外部」、アプリ名は `atara-calendar` など）。画面の名前は「Google Auth Platform」に変わっている場合がある。
   - テストユーザーに、自分の Gmail アドレスを追加する。
   - 公開ステータスは「テスト」のままでよい（本番公開の申請は要らない）。
   - **Why**: Access が Google に求める権限は `openid`・`email`・`profile` だけで、この場合は、テスト中でもログインの期限切れの制限がありません。そのうえで、テストユーザーを自分だけにしておけば、Access より手前の Google の段階でも、他人を弾けます。
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

設定する値は [設計書 10.1](design/design.md#101-cloudflare-access-の設定) に従います。ここには、画面での操作だけを書きます。

1. Zero Trust の **Access → Applications → Add an application → Self-hosted** を選ぶ。
2. アプリの設定で、次のようにする。
   - アプリ名は `atara-calendar`、ドメインは `calendar.ataraman.com`（パスは空のまま）にする。
   - セッションの長さ（Session Duration）を、設計書 10.1 のとおり **1 month** にする。
   - **Accept all available identity providers を OFF** にして、**Google だけ**を選ぶ。可能なら「Instant Auth」を ON にする（選択画面を飛ばして Google に進む）。
     - **Why**: ON のままだと、Google 以外のログイン方法（ワンタイム PIN など）も使えてしまい、設計書 10.1 の「ログイン方法は Google」から外れるからです。
3. ポリシーを1つ作る。
   - Action: **Allow**
   - Include: **Emails** に、自分の Gmail アドレスを1つだけ入れる（要件 AU-1）
   - ポリシーのセッションの長さは、**アプリと同じ（Same as application session timeout）のまま**にする。
     - **Why**: ポリシー側で設定すると、アプリの1か月（要件 AU-2）より優先されてしまうからです。
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

### 4.2 GitHub の環境（Environment）に登録する

リポジトリ `atara-327/atara-calendar` の Settings で、次の順に行う。

1. **Settings → Environments → New environment** で、`production` という名前の環境を作る。
2. 作った環境の画面で、**Deployment branches and tags** を「Selected branches and tags」にして、`main` だけを足す。
3. 同じ画面の **Environment secrets** に、次の3つを登録する。

   | 名前 | 値 |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | 4.1 のトークン |
   | `CLOUDFLARE_ACCOUNT_ID` | 4.1 の Account ID |
   | `ALLOWED_EMAIL` | 自分の Gmail アドレス（Cloudflare のアカウントの表記と同じ大文字小文字で） |

4. **リポジトリの Secret（Settings → Secrets and variables → Actions → Repository secrets）に登録済みの `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` は、削除する。**（以前の手順で、すでにリポジトリの Secret に登録した人向け。上の手順 3 で環境に登録し直してから消す。）

- **Why 環境に置くのか**: リポジトリの Secret は、同じリポジトリのブランチからの PR の CI でも読めます。PR の側でワークフローを書き換えれば、レビュー前のコードがトークンを使えてしまいます。main だけが使える環境に置けば、main に入ったコードからしか読めません。4 の削除を忘れると、この守りが意味をなくします。
- **`ALLOWED_EMAIL` は、ログで伏せ字にするためだけに使う**（Worker の Secret とは別。Worker の方は 7 で登録する）。
  - **Why**: このリポジトリは public で、Actions のログは誰でも読めます。wrangler は認証エラーのとき、トークンの持ち主のメールアドレスをログに出すので、先に伏せ字にしておきます。伏せ字は文字列の一致で行うので、大文字小文字まで Cloudflare のアカウントの表記と同じにします。
  - 未登録のままだと、デプロイは最初のステップで止まります。
- **`DEPLOY_ENABLED` は、今までどおり環境ではなく、リポジトリの変数にする**（6 で入れます。ここではまだ入れません）。
  - **Why**: ジョブを動かすかどうかの判定（`if`）の時点では、環境の変数はまだ読めないからです。

## 5. Claude に伝える

次の3つは秘密ではないので、チャットで Claude に伝えてください。Claude が `wrangler.jsonc` に入れて PR を出します。

| 値 | 例 | どこで控えたか |
| --- | --- | --- |
| D1 の Database ID | `12345678-90ab-...` | 1 |
| チームのドメイン | `xxxx.cloudflareaccess.com` | 2.1 |
| Access の AUD タグ | 長い英数字 | 3 |

## 6. 最初のデプロイを動かす

5 の PR がマージされた後に行います。

1. Cloudflare の **DNS → Records** で、`calendar.ataraman.com` のレコードがないか確かめる。残したいものがあれば、先に別の名前に移す。
   - **Why**: すでに `calendar.ataraman.com` のレコード（CNAME など）があると、デプロイが確認なしに置き換えます（CI では確認を出せないため）。Worker の Custom Domain は、DNS のレコードと証明書を Cloudflare が自動で作るので、同じ名前の既存のレコードとぶつかるからです。
2. リポジトリの **Settings → Secrets and variables → Actions** の **Variables** タブ（**Repository variables**）で、`DEPLOY_ENABLED` に `true` を登録する。
   - **Why PR のマージの後なのか**: これを `true` にした時点から、main に取り込むたびに本番へ自動でデプロイされるからです。本番用の値（5）が `wrangler.jsonc` に入る前に動くと、デプロイが失敗します。
3. リポジトリの **Actions → CI → Run workflow** で、main を選んで実行する（Claude に頼んでもよい。Claude の環境から動かせない場合は、自分で動かす）。
4. 「deploy」が成功したら、Cloudflare に Worker `atara-calendar` ができ、`https://calendar.ataraman.com` で画面が開けるようになる（Google でのログインを求められる）。

## 7. 許可するメールアドレスを Worker に登録する

1. ダッシュボードの **Workers & Pages → atara-calendar → Settings → Variables and Secrets** を開く。
2. **Add → Secret** で、名前 `ALLOWED_EMAIL`、値に自分の Gmail アドレス（3 のポリシーと同じもの）を入れて保存する。
   - **種類は必ず Secret にする。** Text（平文の変数）にすると、次のデプロイで消えます（wrangler は、設定ファイルにない変数を消すため）。
   - **Why Secret にするのか**: リポジトリにメールアドレスを残さないためです（[設計書 10.4](design/design.md#104-秘密情報nf-3)）。
   - この登録までは、画面は開けても API がすべて拒否されます（設定漏れで素通りしないための動き）。
   - **Why 最初のデプロイの後なのか**: Worker が Cloudflare にできてからでないと、Secret を登録する場所がないからです。

## 8. 動作を確認する

1. PC のブラウザで `https://calendar.ataraman.com` を開く（Google でのログインを求められる）。
2. 画面が開いたら、開発者ツール（F12）の **Console** で、次を実行する。

   ```js
   await (await fetch('/api/health')).json();
   ```

   `{ ok: true }` が返れば成功です。

   - **403** のとき: AUD・チームのドメイン・メールアドレスのどれかが食い違っています。`wrangler.jsonc` の `ACCESS_AUD`・`ACCESS_TEAM_DOMAIN` を、Access のアプリの値（2.1・3）と見比べ、Worker の `ALLOWED_EMAIL`（7）を、Access のポリシーのメールアドレス（3）と見比べてください。
   - **500** のとき: Worker の `ALLOWED_EMAIL` が未登録です（7）。
   - 原因は、ダッシュボードの **Workers & Pages → atara-calendar → Logs** で、Worker のログを見ると分かります。
3. 別の Google アカウントで開いて（シークレットウィンドウなど）、Access で弾かれることも確かめる（要件 AU-1）。

> アドレス欄に `/api/health` を直接入れて開くと、403 になります。これは正常です。API は、同じサイトの画面からのリクエストだけを通すためです（[設計書 10.3](design/design.md#103-その他の対策)）。

## 9. あると安心な設定（任意）

- Cloudflare の **SSL/TLS → Edge Certificates** で、**Always Use HTTPS** と **HSTS** を ON にする。
  - **Why**: `http://` で開いたときも必ず暗号化された通信になり、通信の途中での書き換えを防げるからです。
  - Always Use HTTPS と HSTS は、`calendar.ataraman.com` だけでなく `ataraman.com` 全体（ゾーン）の設定です。HSTS の **Include subdomains** と **Preload** は、ほかのサブドメインの事情（`http://` でしか開けないものがないか）を確かめてから ON にしてください。
