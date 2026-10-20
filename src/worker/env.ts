/**
 * Worker が受け取る設定。wrangler.jsonc の vars から作った型（worker-configuration.d.ts）に、
 * Secrets と .dev.vars の値を足している。Secrets は wrangler.jsonc に書かないので、型が自動では作られない。
 * 設定されていないことがあるので、すべて省略できる形にしている。
 */
export type Bindings = Env & {
  /** ログインを許可するメールアドレス（Secrets）。 */
  ALLOWED_EMAIL?: string;
  /** 許可するサービストークンの Client ID（Secrets）。MCP を作るまでは空。 */
  ALLOWED_SERVICE_TOKEN_ID?: string;
  /** 'dev' のときだけ JWT の確認を省略する（.dev.vars）。本番には設定しない。 */
  AUTH_MODE?: string;
};

/** リクエストをしてきた相手。サービストークンは将来の MCP 用。 */
export type Actor = { kind: 'user'; email: string } | { kind: 'service' };

export type Variables = { actor: Actor };

export type AppEnv = { Bindings: Bindings; Variables: Variables };
