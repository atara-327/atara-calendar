import { createElement, use, type ComponentProps } from 'react';
import type { EntryForm as EntryFormType } from './EntryForm';

const loadEntryForm = () => import('./EntryForm');

// 静的に import しないのは、予定のフォームを、最初に読むファイルから外すため（設計書 6.5）。
// React.lazy を使わないのは、lazy が失敗を覚え、電波が戻っても読み直さないため。読み込みの Promise を自分で持ち、
// 失敗したら捨てる（resetEntryFormLoad）。
let loading: Promise<typeof import('./EntryForm')> | null = null;

function load(): Promise<typeof import('./EntryForm')> {
  loading ??= loadEntryForm();
  return loading;
}

/** 読み込みに失敗したあと、次に開くときに読み直せるようにする。 */
export function resetEntryFormLoad(): void {
  loading = null;
}

/** 読み込みが終わるまで、Suspense に待たせる。失敗したら投げる（FormLoadBoundary が受け止める）。 */
export function LazyEntryForm(props: ComponentProps<typeof EntryFormType>) {
  return createElement(use(load()).EntryForm, props);
}

/** 最初の表示が終わって手が空いたときに先読みし、最初にフォームを開くときに待たないようにする。 */
export function preloadEntryFormWhenIdle(): void {
  const preload = () => {
    // 失敗しても、ここでは何もしない。開くときに読み直す（失敗したら、閉じて知らせる。FormLoadBoundary）。
    void load().catch(() => {
      resetEntryFormLoad();
    });
  };
  // requestIdleCallback は Safari にないため、setTimeout に替える。
  if (typeof requestIdleCallback === 'function') requestIdleCallback(preload);
  else setTimeout(preload, 1);
}
