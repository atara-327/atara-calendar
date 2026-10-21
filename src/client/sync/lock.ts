// 同じ端末の複数のタブのうち、最後に開いたタブだけを動かす（設計書 6.2）。
// 新しいタブが、Web Locks API の錠を奪い（steal）、古いタブは、錠を失ったことを知って止まる。
// Why: 自分 1 人の利用で、同じ端末の複数のタブはまれなので、タブ同士の調整の仕組み（どのタブが送るかの
// 選出など）を増やすほど、不具合の余地が増える。最後に開いたタブにするのは、スマホで裏に残った古いタブに、
// 邪魔されないため。

export interface TabLockHandle {
  /** 錠を手放す。自分で止めるときに呼ぶ。奪われたときは、呼ばなくてよい。 */
  release(): void;
}

export interface TabLock {
  /**
   * 錠を取る（ほかのタブが持っていれば奪う）。取れたら解決する。
   * その後、別のタブに奪われたら、onLost を 1 回呼ぶ。
   */
  acquire(onLost: () => void): Promise<TabLockHandle>;
}

/** アプリ固有の名前。同じオリジンの別のアプリの錠と、取り合わないため。 */
export const TAB_LOCK_NAME = 'atara-calendar-sync';

/**
 * Web Locks API で錠を取る。locks が undefined（navigator.locks がないブラウザ）なら、調整せずに動かす。
 * Why not: 錠がないからといって、動かさないという選択はしない。古いブラウザで、予定が見られなくなる方が、
 * 複数のタブで同時に送る（送信は何度送っても結果が変わらないので、害は小さい）よりも困る。
 */
export function createWebLock(
  locks: LockManager | undefined,
  { name = TAB_LOCK_NAME }: { name?: string } = {},
): TabLock {
  if (locks === undefined) {
    return {
      acquire() {
        console.warn(
          'このブラウザには Web Locks API がないので、複数のタブの調整をせずに動かします',
        );
        return Promise.resolve({ release: () => undefined });
      },
    };
  }
  return {
    acquire(onLost) {
      return new Promise((resolve, reject) => {
        let granted = false;
        let release: () => void = () => undefined;
        // この Promise が解決するまで、錠を持ち続ける。
        const held = new Promise<void>((resolveHeld) => {
          release = resolveHeld;
        });
        // steal: true の錠の request は、奪われると、AbortError で拒否される。取れる前に拒否されるのは、
        // 錠の仕組みの失敗なので、acquire の失敗として返す。
        const request: Promise<unknown> = locks.request(name, { steal: true }, () => {
          granted = true;
          resolve({
            release: () => {
              release();
            },
          });
          return held;
        });
        request.then(
          () => undefined,
          (error: unknown) => {
            if (granted) onLost();
            else reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
    },
  };
}
