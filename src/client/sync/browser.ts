import type { PageEvents, SyncEnvironment } from './engine';
import { createWebLock } from './lock';
import { createIdbStorage } from './storage';

/**
 * タブの前面・裏と、電波の復帰の出来事。
 * 裏に回る・閉じるは、visibilitychange の hidden と pagehide の両方を見る。pagehide だけだと、スマホで
 * タブを切り替えたときに、出来事が来ないことがある。visibilitychange だけだと、閉じるときに来ないブラウザがある。
 */
function browserPage(): PageEvents {
  return {
    isVisible: () => document.visibilityState === 'visible',
    subscribe(handlers) {
      const onVisibilityChange = () => {
        if (document.visibilityState === 'visible') handlers.visible();
        else handlers.hidden();
      };
      const onOnline = () => {
        handlers.online();
      };
      const onPageHide = () => {
        handlers.hidden();
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      window.addEventListener('online', onOnline);
      window.addEventListener('pagehide', onPageHide);
      return () => {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('online', onOnline);
        window.removeEventListener('pagehide', onPageHide);
      };
    },
  };
}

/** ブラウザで動かすときの環境。 */
export function createBrowserEnvironment(): SyncEnvironment {
  return {
    // 同じオリジンの /api/... を、ブラウザの fetch で呼ぶ。Sec-Fetch-Site: same-origin は、ブラウザが付ける（設計書 10.3）。
    fetch: (url, init) => fetch(url, init),
    storage: createIdbStorage(),
    locks: createWebLock('locks' in navigator ? navigator.locks : undefined),
    page: browserPage(),
    now: () => Date.now(),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => {
      if (typeof handle === 'number') window.clearTimeout(handle);
    },
    // 端末で新しい行の id を作る（設計書 4.3）。https か localhost（安全なコンテキスト）でだけ使える。
    randomUUID: () => crypto.randomUUID(),
  };
}
