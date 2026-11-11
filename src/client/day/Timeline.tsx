import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { todayJst, utcMsToJstMinuteOfDay, type DateStr } from '../../shared/date';
import { classNames } from '../classNames';
import { readableTextColor } from '../color';
import { EmojiText } from '../emoji/EmojiText';
import { formatTime } from '../dateFormat';
import { openEditForm } from '../form/instance';
import { moveOccurrence } from '../form/move';
import type { TimelineItem } from './dayItems';
import { createDragTracker } from '../dragTracker';
import { movedTimes, snapMoveMinutes } from './dragMove';
import type { DayPlacement } from './layout';
import { HOUR_LABELS, MIN_ITEM_HEIGHT, PX_PER_MINUTE, TWO_LINE_HEIGHT } from './timelineGeometry';
import styles from './Timeline.module.css';
import { useNowMinute } from './useNowMinute';

function percent(ratio: number): string {
  return `${String(ratio * 100)}%`;
}

/** ずらしたあとの時刻の表示「10:22〜11:22」。 */
function movedLabel(item: TimelineItem, by: number): string {
  const { startTime, endTime } = movedTimes(item.start, item.end, by);
  return `${formatTime(startTime)}〜${formatTime(endTime)}`;
}

interface TimelineButtonProps {
  item: TimelineItem;
  placement: DayPlacement;
  /** ドラッグ中の、置いた位置からの縦の距離（px）。ドラッグ中でなければ null。 */
  dragDy: number | null;
  /** ドラッグ中の距離を知らせる。終わったら null。 */
  onDragDy: (dy: number | null) => void;
}

function TimelineButton({ item, placement, dragDy, onDragDy }: TimelineButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const lastPointerType = useRef('mouse');
  // ドラッグの判定（dragMove.ts）は、1 つのボタンに 1 つ持つ。判定は、項目の中身を知らない（距離だけ）。
  // 15 分刻みと端で止める計算は、描くときと、離したときに、今の項目から行う。
  const [tracker] = useState(() =>
    createDragTracker({
      onActivate: () => {
        onDragDy(0);
      },
      onMove: onDragDy,
      onAbort: () => {
        onDragDy(null);
      },
    }),
  );
  const dragging = dragDy !== null;
  const moveBy = dragDy === null ? null : snapMoveMinutes(dragDy, item.start, item.end);

  // ドラッグ中は、縦のスクロールを止める。touch-action は、指を置いたあとでは変えられないので、
  // touchmove を、passive でない listener で止める（React の onTouchMove は passive で、止められない）。
  // Why not ドラッグが始まってから付ける: 指を置いた時点で passive でない listener がないと、ブラウザが
  // その後の touchmove を止められない形で送り、縦のスクロールが始まって、ドラッグが取り消されるため。
  useEffect(() => {
    const button = buttonRef.current;
    if (!item.movable || button === null) return;
    const prevent = (event: TouchEvent) => {
      if (tracker.isDragging() && event.cancelable) event.preventDefault();
    };
    button.addEventListener('touchmove', prevent, { passive: false });
    return () => {
      button.removeEventListener('touchmove', prevent);
    };
  }, [item.movable, tracker]);

  // 1 分刻みなので、短い項目でも題名が読めるよう、15 分ぶんの高さを下限にする。
  const height = Math.max(MIN_ITEM_HEIGHT, (item.end - item.start) * PX_PER_MINUTE);
  const timeLabel = moveBy === null ? item.timeLabel : movedLabel(item, moveBy);
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={item.accessibleName}
      className={classNames(
        styles.item,
        item.color === null && styles.block,
        height < TWO_LINE_HEIGHT && styles.compact,
        item.movable && styles.movable,
        dragging && styles.dragging,
      )}
      // 位置と大きさは、時刻と重なりから、実行時に決まる。ワークスペースの色も同じ。CSP の下でも使える
      // React の style（CSSOM）で与える（設計書 11.2）。タイムブロックは、固定の色なので、CSS Modules。
      style={{
        top: (item.start + (moveBy ?? 0)) * PX_PER_MINUTE,
        height,
        left: percent(placement.column / placement.columns),
        width: percent(1 / placement.columns),
        ...(item.color === null
          ? {}
          : { backgroundColor: item.color, color: readableTextColor(item.color) }),
      }}
      onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
        lastPointerType.current = event.pointerType;
        if (!item.movable || (event.pointerType === 'mouse' && event.button !== 0)) return;
        tracker.start(
          event.clientX,
          event.clientY,
          event.pointerId,
          event.isPrimary,
          event.pointerType,
        );
        // マウスが、項目の外に出ても、動きを受け取る。
        if (event.pointerType === 'mouse') event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event: PointerEvent<HTMLButtonElement>) => {
        // ドラッグ中の動きは、日表示のスワイプの判定（DayView）に渡さない。
        if (tracker.isDragging()) event.stopPropagation();
        tracker.move(event.clientX, event.clientY, event.pointerId);
      }}
      onPointerUp={(event: PointerEvent<HTMLButtonElement>) => {
        const dy = tracker.end(event.clientY, event.pointerId);
        if (dy === null) return;
        event.stopPropagation();
        onDragDy(null);
        const by = snapMoveMinutes(dy, item.start, item.end);
        // 保存は、フォームで時刻を変えて保存したときと同じ道（form/move.ts）。
        if (by !== 0) moveOccurrence(item.occurrence, movedTimes(item.start, item.end, by));
      }}
      onPointerCancel={(event: PointerEvent<HTMLButtonElement>) => {
        if (tracker.isDragging()) event.stopPropagation();
        tracker.cancel(event.pointerId);
      }}
      // スマホの長押しで出る、メニューを出さない。
      onContextMenu={(event) => {
        if (item.movable && lastPointerType.current !== 'mouse') event.preventDefault();
      }}
      onClick={(event) => {
        // ドラッグのあとの click は、フォームを開かない。
        if (tracker.consumeClick(event.detail)) return;
        openEditForm(item.occurrence);
      }}
    >
      {/* 15 分の項目は、2 行目がないので、動かしている間は、題名の代わりに、新しい時刻を出す。 */}
      {dragging && height < TWO_LINE_HEIGHT ? (
        <span className={styles.itemTime}>{timeLabel}</span>
      ) : (
        <>
          <span className={styles.itemTitle}>
            <EmojiText text={item.title} />
          </span>
          {height >= TWO_LINE_HEIGHT && <span className={styles.itemTime}>{timeLabel}</span>}
        </>
      )}
    </button>
  );
}

/**
 * 今の時刻の線。1 分ごとに動く。今日の日表示にだけ出す。
 * 今日かどうかは、この中で、線と同じ時刻（useNowMinute）で決める。Why not 呼び出し側が、useToday で決めて、
 * 今日のときだけ描く: useToday は 60 秒ごとにしか見ないので、明日の日表示を開いたまま 0:00 を迎えると、
 * 線が出るのが、最大 1 分遅れる。常に描いて、中で判定すれば、分が変わる瞬間に、線と同時に出る。
 */
function NowLine({ date }: { date: DateStr }) {
  const nowMs = useNowMinute();
  if (todayJst(nowMs) !== date) return null;
  return (
    <div
      className={styles.nowLine}
      style={{ top: utcMsToJstMinuteOfDay(nowMs) * PX_PER_MINUTE }}
      aria-hidden="true"
    />
  );
}

interface TimelineProps {
  items: readonly TimelineItem[];
  /** items と同じ順の、横の位置（layoutDay の結果）。 */
  placements: readonly DayPlacement[];
  /** 見ている日。今日のときだけ、今の時刻の線を出す。 */
  date: DateStr;
  /**
   * 項目を並べる領域（時間軸の右側）を押したときの処理。押した位置の時刻は、この領域の上端
   * （event.currentTarget の getBoundingClientRect）からの距離で求める。項目と線の上の押下は、ここに届かない
   * （項目は自分のボタンで受け、線は pointer-events: none）ので、event.target が領域そのものなら、空いているところ。
   */
  onTrackClick: (event: MouseEvent<HTMLDivElement>) => void;
}

/**
 * タイムライン（DV-1〜4）。0:00〜24:00 を、1 時間 60px で並べ、左に時刻の目盛り、右に項目を出す。
 * 項目は `<button>` で、押すと、その回のフォームが開く。空いているところ（項目と線の外）を押すと、
 * その時刻のタイムブロックを作る（onTrackClick）。
 *
 * 空いているところは、キーボードでは押せない（Tab で届かない）。Why not `<button>` にする: タイムラインの
 * 全面を覆う 1 つのボタンは、読み上げで「何のボタンか」を言えず、Tab でも項目の間に挟まって邪魔になる。
 * キーボードや読み上げからは、( + ) ボタンで、同じタイムブロックを作れる（設計書 11.3）。
 */
export function Timeline({ items, placements, date, onTrackClick }: TimelineProps) {
  // ドラッグ中の項目と、ずらしている距離。
  const [drag, setDrag] = useState<{ key: string; dy: number } | null>(null);
  return (
    <div className={styles.timeline}>
      <div className={styles.ruler} aria-hidden="true">
        {HOUR_LABELS.map((label) => (
          <span key={label} className={styles.hourLabel}>
            {label}
          </span>
        ))}
      </div>
      <div className={styles.track} onClick={onTrackClick}>
        {HOUR_LABELS.map((label) => (
          <div key={label} className={styles.hourLine} />
        ))}
        <div className={styles.items}>
          {items.map((item, index) => {
            const placement = placements[index];
            return placement === undefined ? null : (
              <TimelineButton
                key={item.key}
                item={item}
                placement={placement}
                dragDy={drag?.key === item.key ? drag.dy : null}
                onDragDy={(dy) => {
                  setDrag(dy === null ? null : { key: item.key, dy });
                }}
              />
            );
          })}
        </div>
        <NowLine date={date} />
      </div>
    </div>
  );
}
