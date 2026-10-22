// 前回、新しく予定を作ったときのワークスペースを、端末に覚える（EV-8。設計書 11.4）。
// DB（同期の対象）に入れないのは、入力を楽にするための補助で、予定のデータそのものではないため。

const STORAGE_KEY = 'lastWorkspaceId';

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * localStorage は、使えない環境（プライベートブラウズ、保存を禁じる設定）で、触っただけ・書いただけで
 * 例外を投げることがある。覚えられなくても、予定は作れるので、握りつぶして、覚えない・見つからない扱いにする。
 * 例外を握りつぶしても、画面には知らせない。入力を楽にする補助が使えないだけで、利用者が困らないため。
 */
function browserStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** storage は、テストで差し替える。省くと、このブラウザの localStorage。 */
export function loadLastWorkspaceId(
  storage: KeyValueStorage | null = browserStorage(),
): string | null {
  try {
    return storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveLastWorkspaceId(
  workspaceId: string,
  storage: KeyValueStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, workspaceId);
  } catch {
    // 上のコメントのとおり、覚えられなくても、何もしない。
  }
}
