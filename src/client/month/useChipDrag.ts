import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import type { DateStr } from '../../shared/date';
import type { Occurrence } from '../../shared/recurrence';
import { createDragTracker } from '../dragTracker';
import { moveOccurrence } from '../form/move';
import { openEditForm } from '../form/instance';
import { dayShift, movedDates } from './dragMove';
import { dateAtPoint, setDropDate } from './dropTarget';

interface ChipDragProps {
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

/**
 * 月表示の予定（横棒・時間指定）を、ドラッグで別の日へ移す（EV-6。設計書 11.2）。ボタンに付ける props と、
 * ドラッグ中かを返す。ref は、呼び出し側が作って、ボタンに付ける（touchmove の listener を付けるため）。始まり方は日表示と同じ判定（dragTracker.ts）。落ちた日の計算は dragMove.ts。
 */
export function useChipDrag(
  ref: RefObject<HTMLButtonElement | null>,
  occurrence: Occurrence,
): { dragging: boolean; props: ChipDragProps } {
  const lastPointerType = useRef('mouse');
  // 押した位置のマスの日。複数日の横棒は、予定の開始日ではなく、ここからの差で動かす。
  const pressedDate = useRef<DateStr | null>(null);
  const [dragging, setDragging] = useState(false);
  const [tracker] = useState(() =>
    createDragTracker({
      onActivate: () => {
        setDragging(true);
      },
      // 動きの先（落ち先）は、距離ではなく、指の位置から求める（onPointerMove）。
      onMove: () => undefined,
      onAbort: () => {
        setDragging(false);
        setDropDate(null);
      },
    }),
  );

  // 始まった時点で、押したマスを落ち先にする（長押しは、指が動かなくても始まる）。
  useEffect(() => {
    if (dragging) setDropDate(pressedDate.current);
  }, [dragging]);

  // ドラッグ中は、縦のスクロールを止める。日表示（Timeline.tsx）と同じ。passive でない listener を最初から付けておく
  // 理由も、そちらのコメントのとおり（あとから付けると、ブラウザが止められない形で touchmove を送る）。
  useEffect(() => {
    const button = ref.current;
    if (button === null) return;
    const prevent = (event: TouchEvent) => {
      if (tracker.isDragging() && event.cancelable) event.preventDefault();
    };
    button.addEventListener('touchmove', prevent, { passive: false });
    return () => {
      button.removeEventListener('touchmove', prevent);
      // ドラッグ中に消えたら（同期で予定が変わったとき）、落ち先の強調を残さない。
      if (tracker.isDragging()) setDropDate(null);
    };
  }, [ref, tracker]);

  return {
    dragging,
    props: {
      onPointerDown: (event) => {
        lastPointerType.current = event.pointerType;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        pressedDate.current = dateAtPoint(event.clientX, event.clientY);
        tracker.start(
          event.clientX,
          event.clientY,
          event.pointerId,
          event.isPrimary,
          event.pointerType,
        );
        // マウスが、予定の外に出ても、動きを受け取る。
        if (event.pointerType === 'mouse') event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event) => {
        tracker.move(event.clientX, event.clientY, event.pointerId);
        if (tracker.isDragging()) setDropDate(dateAtPoint(event.clientX, event.clientY));
      },
      onPointerUp: (event) => {
        if (tracker.end(event.clientY, event.pointerId) === null) return;
        setDragging(false);
        setDropDate(null);
        const dropped = dateAtPoint(event.clientX, event.clientY);
        const pressed = pressedDate.current;
        if (dropped === null || pressed === null) return;
        const moved = movedDates(occurrence, dayShift(pressed, dropped));
        // 保存は、フォームで日付を変えて保存したときと同じ道（form/move.ts）。
        if (moved !== null) moveOccurrence(occurrence, moved);
      },
      onPointerCancel: (event) => {
        tracker.cancel(event.pointerId);
      },
      // スマホの長押しで出る、メニューを出さない。
      onContextMenu: (event) => {
        if (lastPointerType.current !== 'mouse') event.preventDefault();
      },
      onClick: (event) => {
        // ドラッグのあとの click は、フォームを開かない。
        if (tracker.consumeClick(event.detail)) return;
        openEditForm(occurrence);
      },
    },
  };
}
