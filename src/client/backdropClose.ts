import { useState, type MouseEvent, type PointerEvent } from 'react';

// <dialog>（showModal）の背景（::backdrop）を押して閉じるための判定（設計書 11.4・11.5）。
// サイドメニュー・予定のフォーム・ワークスペースの編集の 3 つが、同じ判定を使う。
// 背景を押したとき、pointerdown と click の target は、dialog そのもの。中身が dialog の全面を覆っていれば、
// 中身を押したときの target は、中身の要素になる。
// Why 押し始めの位置も確かめる: 入力欄で文字を選ぶ途中に、指（マウス）が背景にはみ出して離すと、その click は
// 背景に当たる（押し始めと離した位置の共通の祖先、つまり dialog が target になる）。click の target だけで閉じると、
// 入力を失う。
// Why 続けて押した 2 回目以降（click の detail が 2 以上）では閉じない: ( + ) などをダブルクリックすると、1 回目で
// ダイアログが開き、2 回目が、開いた直後の背景に当たって、開いてすぐ閉じるため。背景を押して閉じるなら、1 回目で
// 閉じるので、背景に 2 回目の click が来るのは、1 回目が別の場所（開くボタン）だったときだけ。
// Why not ::backdrop にイベントを付ける: ::backdrop は疑似要素で、イベントを受け取れない。

export interface BackdropPress {
  /** 押し始めた（pointerdown）。その位置が背景か、を覚える。 */
  start(onBackdrop: boolean): void;
  /**
   * click が届いた。押し始めも click の対象も背景で、続けて押した 2 回目以降（clickCount が 2 以上）でなければ true。
   * 判定のたびに、覚えた位置は消す。clickCount は、click の detail。
   */
  end(onBackdrop: boolean, clickCount?: number): boolean;
}

export function createBackdropPress(): BackdropPress {
  let startedOnBackdrop = false;
  return {
    start(onBackdrop) {
      startedOnBackdrop = onBackdrop;
    },
    end(onBackdrop, clickCount = 1) {
      const closes = startedOnBackdrop && onBackdrop && clickCount <= 1;
      startedOnBackdrop = false;
      return closes;
    },
  };
}

/**
 * 背景を押したら onClose を呼ぶ、<dialog> のイベントの属性。`<dialog {...backdropClose}>` のように渡す。
 * onClose は、✕ と同じ閉じ方（積んだ履歴を戻す関数）を渡す。
 */
export function useBackdropClose(onClose: () => void): {
  onPointerDown: (event: PointerEvent<HTMLDialogElement>) => void;
  onClick: (event: MouseEvent<HTMLDialogElement>) => void;
} {
  const [press] = useState(createBackdropPress);
  return {
    onPointerDown: (event) => {
      press.start(event.target === event.currentTarget);
    },
    onClick: (event) => {
      if (press.end(event.target === event.currentTarget, event.detail)) onClose();
    },
  };
}
