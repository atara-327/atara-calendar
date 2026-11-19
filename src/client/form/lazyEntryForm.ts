import { lazy } from 'react';

// 静的に import しないのは、予定のフォームを、最初に読むファイルから外すため（設計書 6.5）。
const loadEntryForm = () => import('./EntryForm').then((module) => ({ default: module.EntryForm }));

export const LazyEntryForm = lazy(loadEntryForm);

/** 最初の表示が終わって手が空いたときに先読みし、最初にフォームを開くときに待たないようにする。 */
export function preloadEntryFormWhenIdle(): void {
  const load = () => {
    // 失敗しても、開くときに lazy が読み直す。ここで止めない。
    void loadEntryForm().catch(() => undefined);
  };
  // requestIdleCallback は Safari にないため、setTimeout に替える。
  if (typeof requestIdleCallback === 'function') requestIdleCallback(load);
  else setTimeout(load, 1);
}
