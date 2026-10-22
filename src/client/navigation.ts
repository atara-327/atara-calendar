import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { DateStr } from '../shared/date';
import { MONTH_PATH, dayPath, parseRoute, type Route } from './route';

// 画面の切り替え（URL）は、History API（pushState・popstate）で手書きする。
// ルーターのライブラリを使わないのは、画面が月表示と日表示の 2 つだけで、依存とバンドルを増やすほどの
// 仕組みが要らないため（設計書 2章・11.2）。

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // 戻る・進むの操作は popstate で届く。pushState・replaceState は何も送らないので、notify で知らせる。
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

function getPathname(): string {
  return window.location.pathname;
}

/** この画面の中で pushState した履歴の印。アドレスを直接開いた最初の履歴には、付いていない。 */
const IN_APP_STATE = { inApp: true };

function isInAppState(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'inApp' in state && state.inApp === true;
}

/** path へ移る（履歴を 1 つ積む）。今のパスと同じなら、何もしない。 */
export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState(IN_APP_STATE, '', path);
  notify();
}

/** 履歴を積まずに、今の履歴を path に置き換える。 */
function replacePath(path: string): void {
  window.history.replaceState(window.history.state, '', path);
  notify();
}

/**
 * 日表示で、別の日へ移る（‹ ›・スワイプ・［今日］）。履歴を積まずに、今の履歴を置き換える。今の日と同じなら、何もしない。
 * 日ごとに積む（navigate）と、日表示を何日か動いたあと、［月表示］（goToMonth）もスマホの「戻る」も、
 * 月表示ではなく、前の日に戻ってしまう。置き換えれば、月表示から日表示へ移ったときに積んだ履歴の 1 つのまま、
 * 何日動いても、「戻る」が月表示に戻る。置き換えても履歴の印（history.state）は保つので、goToMonth は、
 * 動いたあとも、この画面で積んだ履歴だと分かる。
 * Why not 日ごとに積んで、戻るたびに前の日を見られるようにする: 日表示は、日をめくって見るもので、
 * 「戻る」は、月表示へ戻るために使いたいため（日の移動は、‹ › で戻れる）。
 */
export function replaceDay(date: DateStr): void {
  const path = dayPath(date);
  if (path === window.location.pathname) return;
  replacePath(path);
}

/**
 * 月表示へ戻る。この画面から移ってきたのなら「戻る」と同じ（履歴が増えず、スマホの「戻る」と食い違わない）。
 * アドレスを直接開いたときは、戻る先が画面の外なので、月表示へ移る。
 * 日表示の中で日を動いても（replaceDay）、積んだ履歴は 1 つのままなので、動いた日数によらず月表示へ戻る。
 */
export function goToMonth(): void {
  if (isInAppState(window.history.state)) window.history.back();
  else navigate(MONTH_PATH);
}

/**
 * 今の URL が示す画面。形が正しくない URL や範囲外の日付は、月表示にして、URL も `/` に置き換える。
 */
export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, getPathname);
  const route = useMemo(() => parseRoute(pathname), [pathname]);
  // 依存は pathname にする。不正かどうかの真偽だけに依存すると、不正なパスから、別の不正なパスへ変わったとき
  // （どちらも「不正」のまま）に、effect が動かず、URL が置き換わらない。
  useEffect(() => {
    if (parseRoute(pathname) === null) replacePath(MONTH_PATH);
  }, [pathname]);
  return route ?? { name: 'month' };
}
