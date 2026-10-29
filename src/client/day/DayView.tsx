import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { addDays, todayJst, utcMsToJstMinuteOfDay, type DateStr } from '../../shared/date';
import { isDateInSupportedYears } from '../../shared/schema';
import { AddEntryButton } from '../form/AddEntryButton';
import { openCreateForm } from '../form/instance';
import { goToMonth, replaceDay } from '../navigation';
import { createViewSelector } from '../stableRows';
import { useSyncState } from '../sync/instance';
import { SyncOverview } from '../sync/SyncStatus';
import type { SyncState } from '../sync/state';
import { workspaceDisplayOf } from '../workspaceDisplay';
import { BannerList } from './BannerList';
import { DayHeader } from './DayHeader';
import { dayItemsOf, isHolidayShown } from './dayItems';
import styles from './DayView.module.css';
import { layoutDay } from './layout';
import { createSwipeTracker, isClickAfterSwipe } from './swipe';
import {
  PX_PER_MINUTE,
  addButtonStart,
  initialTopMinute,
  shouldPlace,
  tapStartTime,
  type PlacedState,
} from './timelineGeometry';
import { Timeline } from './Timeline';

function selectReady(state: SyncState): boolean {
  return state.phase === 'ready';
}

/** いちばん上に出す位置（px）。今日は今の 1 時間前、他の日は最初の項目（なければ 8:00）。設計書 11.3。 */
function topPixelsFor(date: DateStr, firstItemStart: number | null): number {
  const nowMs = Date.now();
  return (
    initialTopMinute({
      isToday: todayJst(nowMs) === date,
      nowMinute: utcMsToJstMinuteOfDay(nowMs),
      firstItemStart,
    }) * PX_PER_MINUTE
  );
}

/**
 * 日表示（DV-1〜6。設計書 11.3）。固定のヘッダー（［月表示］・前後の日・日付・［今日］）、
 * 上部の欄（祝日・記念日・終日・24 時間以上）、縦にスクロールするタイムライン、タイムブロックを作る ( + ) ボタン。
 */
export function DayView({ date }: { date: DateStr }) {
  const ready = useSyncState(selectReady);
  // 行が変わっていなければ、同じ view が返る（受け取りのたびに、計算し直さないため。stableRows.ts）。
  // selector は、コンポーネントごとに 1 つ作って保つ（前の値を、selector の中に覚えているため）。
  const [selectView] = useState(createViewSelector);
  const view = useSyncState(selectView);

  const display = useMemo(() => workspaceDisplayOf(view.workspaces.values()), [view]);
  // データ（行）か日付が変わったときだけ、回を求め直す。
  const items = useMemo(
    () => dayItemsOf({ entries: [...view.entries.values()], display, date }),
    [view, display, date],
  );
  const isHoliday = useMemo(() => isHolidayShown(date, display), [date, display]);
  const placements = useMemo(() => layoutDay(items.timeline), [items.timeline]);

  const previousDate = addDays(date, -1);
  const nextDate = addDays(date, 1);
  const hasPrevious = isDateInSupportedYears(previousDate);
  const hasNext = isDateInSupportedYears(nextDate);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const placedRef = useRef<PlacedState | null>(null);

  // タイムラインの最初の項目の開始（上部の欄のものは数えない）。
  const firstItemStart = items.timeline.reduce<number | null>(
    (first, item) => (first === null ? item.start : Math.min(first, item.start)),
    null,
  );

  // 最初に表示する位置を、描く前に決める（描いたあとに動かすと、一瞬、0:00 が見える）。
  // 決め直すのは、日付が変わったとき（‹ ›・スワイプ・［今日］）と、/day/... を直接開いて、最初の読み込みが
  // 終わったときの 1 回だけ。読み込みの前は、データがないので、今日なら今の 1 時間前、他の日なら 8:00 に置き、
  // 読み込みが終わったとき、最初の項目の位置に置き直す。
  // 同じ日のまま、データが変わっても（同期）、動かさない。見ている位置が、勝手に動いてしまうため。
  // 置くかどうかの判定は shouldPlace（timelineGeometry.ts）。
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const current = { date, ready };
    if (!shouldPlace(placedRef.current, current)) return;
    placedRef.current = current;
    scroller.scrollTop = topPixelsFor(date, firstItemStart);
    // firstItemStart を依存に入れるのは、読み込みが終わったとき、その値で置き直すため
    // （上の判定で、同じ日のデータの変化では、何もしない）。
  }, [date, ready, firstItemStart]);

  const goToToday = () => {
    const current = todayJst();
    if (current !== date) {
      // 日付が変わるので、位置は、上の effect が、今日の決まり（今の 1 時間前）で置く。
      replaceDay(current);
    } else if (scrollerRef.current !== null) {
      scrollerRef.current.scrollTop = topPixelsFor(date, firstItemStart);
    }
  };

  // 左右のスワイプ（DV-5）。縦のスクロールはブラウザに任せ（touch-action: pan-y pinch-zoom）、判定は swipe.ts。
  // PC（マウス）は対象にしない。PC は ‹ › ボタンで動く。
  const [swipe] = useState(createSwipeTracker);
  const swipedRef = useRef(false);
  const swipeHandlers = {
    onPointerDown: (event: PointerEvent) => {
      swipedRef.current = false;
      if (event.pointerType === 'mouse') return;
      swipe.start(event.clientX, event.clientY, event.pointerId, event.isPrimary);
    },
    onPointerMove: (event: PointerEvent) => {
      if (event.pointerType === 'mouse') return;
      swipe.move(event.clientX, event.clientY, event.pointerId);
    },
    onPointerUp: (event: PointerEvent) => {
      if (event.pointerType === 'mouse') return;
      const direction = swipe.end(event.clientX, event.pointerId);
      if (direction === null) return;
      // この直後に click が届いても、空いているところのタップ（タイムブロックの作成）にしない。
      swipedRef.current = true;
      if (direction === 'left' && hasNext) replaceDay(nextDate);
      if (direction === 'right' && hasPrevious) replaceDay(previousDate);
    },
    // ブラウザが縦のスクロールを始めると届く。動き始めが縦だった、ということ。
    onPointerCancel: (event: PointerEvent) => {
      swipe.cancel(event.pointerId);
    },
    onClickCapture: (event: MouseEvent) => {
      const swallow = isClickAfterSwipe(swipedRef.current, event.detail);
      swipedRef.current = false;
      if (!swallow) return;
      event.preventDefault();
      event.stopPropagation();
    },
  };

  // 空いているところ（項目と線の外。track そのもの）をタップしたら、その時刻（15 分単位に切り下げ）から
  // 1 時間のタイムブロックを作るフォームを開く。最初の読み込みが終わるまでは、何もしない
  // （( + ) が押せないのと同じ理由。AddEntryButton.tsx）。
  const onTrackClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!ready || event.target !== event.currentTarget) return;
    const top = event.currentTarget.getBoundingClientRect().top;
    openCreateForm('block', { date, time: tapStartTime(event.clientY - top) });
  };

  return (
    <div className={styles.screen}>
      <DayHeader
        date={date}
        isHoliday={isHoliday}
        hasPrevious={hasPrevious}
        hasNext={hasNext}
        onMonth={goToMonth}
        onPrevious={() => {
          replaceDay(previousDate);
        }}
        onNext={() => {
          replaceDay(nextDate);
        }}
        onToday={goToToday}
      />
      {/* key を日付にして、日を動いたら、作り直す。上部の欄のスクロール位置を、先頭に戻すため。
          両方の日に欄があると、同じ DOM が使い回され、前の日のスクロール位置が残る。 */}
      <BannerList key={date} items={items.banner} />
      <div className={styles.body}>
        <div ref={scrollerRef} className={styles.scroller} {...swipeHandlers}>
          <Timeline
            items={items.timeline}
            placements={placements}
            date={date}
            onTrackClick={onTrackClick}
          />
        </div>
        <SyncOverview />
      </div>
      <AddEntryButton
        kind="block"
        // 見ている日の、今の次の正時から（addButtonStart）。押した時刻で決める（描画した時刻を残さない）。
        start={() => addButtonStart(date, Date.now())}
      />
    </div>
  );
}
