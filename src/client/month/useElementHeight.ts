import { useMemo, useSyncExternalStore } from 'react';

interface HeightStore {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => number;
}

/**
 * 要素の高さを持つ store。高さは、作ったときと、要素の大きさが変わったときだけ、読み直す。
 * 描画のたびに clientHeight を読まないのは、読むたびに、ブラウザが、その場でレイアウトをやり直す（強制リフロー）ため。
 * スクロールで描画が走るたびに、それが起きる。
 */
function createHeightStore(element: HTMLElement): HeightStore {
  let height = element.clientHeight;
  return {
    subscribe: (onChange) => {
      const observer = new ResizeObserver(() => {
        const next = element.clientHeight;
        if (next === height) return;
        height = next;
        onChange();
      });
      observer.observe(element);
      return () => {
        observer.disconnect();
      };
    },
    getSnapshot: () => height,
  };
}

const NO_ELEMENT: HeightStore = { subscribe: () => () => undefined, getSnapshot: () => 0 };

/**
 * 要素の高さ（px）。要素の大きさが変わると、取り直す。要素がまだなければ 0。
 * 要素は、ref ではなく state に持たせて渡す。描画のあとで要素が決まっても、その描画を、画面に出す前にやり直せるため。
 */
export function useElementHeight(element: HTMLElement | null): number {
  const store = useMemo(
    () => (element === null ? NO_ELEMENT : createHeightStore(element)),
    [element],
  );
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
