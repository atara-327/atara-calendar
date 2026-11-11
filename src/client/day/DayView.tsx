import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { addDays, todayJst, type DateStr } from '../../shared/date';
import { isDateInSupportedYears } from '../../shared/schema';
import { AddEntryButton } from '../form/AddEntryButton';
import { openCreateForm } from '../form/instance';
import { goToMonth, replaceDay } from '../navigation';
import { createViewSelector } from '../stableRows';
import { useSyncState } from '../sync/instance';
import { SyncOverview } from '../sync/SyncStatus';
import type { SyncState } from '../sync/state';
import { workspaceDisplayOf } from '../workspaceDisplay';
import { DayHeader } from './DayHeader';
import { dayItemsOf, isHolidayShown } from './dayItems';
import styles from './DayView.module.css';
import { DayPane, NeighborPane, firstItemStartOf, placementsOf, topPixelsFor } from './DayPane';
import { createSwipeTracker, followOffset, isClickAfterSwipe } from './swipe';
import { addButtonStart, shouldPlace, tapStartTime, type PlacedState } from './timelineGeometry';

function selectReady(state: SyncState): boolean {
  return state.phase === 'ready';
}

/** 隣の日へ滑る（元へ戻る）時間（ms）。 */
const SLIDE_MS = 200;

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  const entries = useMemo(() => [...view.entries.values()], [view]);
  // データ（行）か日付が変わったときだけ、回を求め直す。
  const items = useMemo(() => dayItemsOf({ entries, display, date }), [entries, display, date]);
  const isHoliday = useMemo(() => isHolidayShown(date, display), [date, display]);
  const placements = useMemo(() => placementsOf(items.timeline), [items.timeline]);

  const previousDate = addDays(date, -1);
  const nextDate = addDays(date, 1);
  const hasPrevious = isDateInSupportedYears(previousDate);
  const hasNext = isDateInSupportedYears(nextDate);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const placedRef = useRef<PlacedState | null>(null);

  const firstItemStart = firstItemStartOf(items.timeline);

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
  // 動かしている間は、中身（track）を translateX で動かす。毎フレームの再描画は避けたいので、動きは DOM に直接
  // 書き、React の state は「動かしている間だけ、隣の日を描く」ための 1 つだけにする。
  const [swipe] = useState(createSwipeTracker);
  const swipedRef = useRef(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const settlingRef = useRef(false);
  const followRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  // 指を離したあとの動き。target があればその日へ滑って切り替え、なければ元の位置へ戻る。
  const settle = (direction: 'left' | 'right' | null, target: DateStr | null) => {
    const track = trackRef.current;
    if (track === null) return;
    settlingRef.current = true;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    track.style.transition = `transform ${String(SLIDE_MS)}ms ease-out`;
    track.style.transform =
      target === null ? 'translateX(0)' : `translateX(${direction === 'left' ? '-100%' : '100%'})`;
    // Why not transitionend: 動きが無効になった（要素が隠れた）ときなどに届かず、画面が動かしたまま固まるため。
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      track.style.transition = 'none';
      track.style.transform = '';
      if (target !== null) replaceDay(target);
      draggingRef.current = false;
      settlingRef.current = false;
      setDragging(false);
    }, SLIDE_MS);
  };

  const swipeHandlers = {
    onPointerDown: (event: PointerEvent) => {
      swipedRef.current = false;
      if (event.pointerType === 'mouse' || settlingRef.current) return;
      // 「動きを減らす」設定のときは、指についてくる動きも滑る動きも付けず、離したときにすぐ切り替える。
      followRef.current = !prefersReducedMotion();
      swipe.start(event.clientX, event.clientY, event.pointerId, event.isPrimary, event.timeStamp);
    },
    onPointerMove: (event: PointerEvent) => {
      if (event.pointerType === 'mouse') return;
      const dx = swipe.move(event.clientX, event.clientY, event.pointerId, event.timeStamp);
      const track = trackRef.current;
      if (dx === null || !followRef.current || track === null) return;
      track.style.transition = 'none';
      track.style.transform = `translateX(${String(followOffset(dx, hasPrevious, hasNext))}px)`;
      if (!draggingRef.current) {
        draggingRef.current = true;
        setDragging(true);
      }
    },
    onPointerUp: (event: PointerEvent) => {
      // 2 本目の指の離しは、見ない（最初の指は、2 本目が触れた時点で、追跡をやめている）。
      if (event.pointerType === 'mouse' || !event.isPrimary) return;
      // 滑っている間に置いた指（onPointerDown で見ていない）の離しは、見ない。2 回目の settle で、滑りが途中で戻るため。
      if (settlingRef.current) return;
      const direction = swipe.end(event.clientX, event.pointerId, event.timeStamp);
      // この直後に click が届いても、空いているところのタップ（タイムブロックの作成）にしない。
      if (direction !== null) swipedRef.current = true;
      let target: DateStr | null = null;
      if (direction === 'left' && hasNext) target = nextDate;
      if (direction === 'right' && hasPrevious) target = previousDate;
      if (draggingRef.current) settle(direction, target);
      else if (target !== null) replaceDay(target);
    },
    // ブラウザが縦のスクロールを始めると届く。動き始めが縦だった、ということ。
    onPointerCancel: (event: PointerEvent) => {
      swipe.cancel(event.pointerId);
      if (draggingRef.current && event.isPrimary && !settlingRef.current) settle(null, null);
    },
    onClickCapture: (event: MouseEvent) => {
      // 滑っている間のタップは、切り替わる前の日の操作になるので、捨てる。
      const swallow = settlingRef.current || isClickAfterSwipe(swipedRef.current, event.detail);
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
      <div className={styles.body}>
        <div ref={trackRef} className={styles.track}>
          {dragging && hasPrevious && (
            <NeighborPane
              key="before"
              date={previousDate}
              entries={entries}
              display={display}
              side="before"
            />
          )}
          <DayPane
            key="current"
            date={date}
            items={items}
            placements={placements}
            scrollerRef={scrollerRef}
            scrollerProps={swipeHandlers}
            onTrackClick={onTrackClick}
          />
          {dragging && hasNext && (
            <NeighborPane
              key="after"
              date={nextDate}
              entries={entries}
              display={display}
              side="after"
            />
          )}
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
