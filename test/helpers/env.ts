/** テストの Worker の設定（Bindings）に入れる APP_ORIGIN。通知の文面のリンクの頭になる。本番のドメインではない。 */
export const TEST_APP_ORIGIN = 'https://calendar.example';

/**
 * 認証のように DB を使わないテストで、Worker の設定（Bindings）を満たすための D1。
 * 使われたら、テストの前提（DB に触れない）が崩れているので、黙って動かずに例外にする。
 * 型を合わせる `as` は、ここで中身のない D1 を作るためだけに使う。
 */
export const unusedDb: D1Database = new Proxy({} as D1Database, {
  get() {
    throw new Error('このテストでは DB を使わない前提です');
  },
});
