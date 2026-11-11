import { useLayoutEffect, useMemo, useRef, type MouseEvent, type RefObject } from 'react';
import { todayJst, utcMsToJstMinuteOfDay, type DateStr } from '../../shared/date';
import type { Entry } from '../../shared/schema';
import { classNames } from '../classNames';
import type { WorkspaceDisplay } from '../workspaceDisplay';
import { BannerList } from './BannerList';
import { dayItemsOf, type DayItems } from './dayItems';
import styles from './DayView.module.css';
import { layoutDay } from './layout';
import { MIN_ITEM_HEIGHT, PX_PER_MINUTE, initialTopMinute } from './timelineGeometry';
import { Timeline } from './Timeline';

/** いちばん上に出す位置（px）。今日は今の 1 時間前、他の日は最初の項目（なければ 8:00）。設計書 11.3。 */
export function topPixelsFor(date: DateStr, firstItemStart: number | null): number {
  const nowMs = Date.now();
  return (
    initialTopMinute({
      isToday: todayJst(nowMs) === date,
      nowMinute: utcMsToJstMinuteOfDay(nowMs),
      firstItemStart,
    }) * PX_PER_MINUTE
  );
}

/** タイムラインの最初の項目の開始（上部の欄のものは数えない）。 */
export function firstItemStartOf(timeline: DayItems['timeline']): number | null {
  return timeline.reduce<number | null>(
    (first, item) => (first === null ? item.start : Math.min(first, item.start)),
    null,
  );
}

/**
 * タイムラインの並べ方。短い項目は、描く高さ（MIN_ITEM_HEIGHT）と同じ長さで決める。本当の終わりで決めると、
 * すぐ後の項目と同じ列に並び、伸ばして描いた分が重なって隠れる。
 */
export function placementsOf(timeline: DayItems['timeline']) {
  const minMinutes = MIN_ITEM_HEIGHT / PX_PER_MINUTE;
  return layoutDay(
    timeline.map((item) => ({ ...item, end: Math.max(item.end, item.start + minMinutes) })),
  );
}

interface DayPaneProps {
  date: DateStr;
  items: DayItems;
  placements: ReturnType<typeof placementsOf>;
  scrollerRef: RefObject<HTMLDivElement | null>;
  scrollerProps?: object;
  onTrackClick: (event: MouseEvent<HTMLDivElement>) => void;
  /** 隣の日（スワイプで見えてくる側）の置き場所。なければ、見ている日。 */
  side?: 'before' | 'after';
}

/** 1 日分の、上部の欄とタイムライン。 */
export function DayPane({
  date,
  items,
  placements,
  scrollerRef,
  scrollerProps,
  onTrackClick,
  side,
}: DayPaneProps) {
  const className = classNames(
    styles.pane,
    side !== undefined && styles.neighbor,
    side === 'before' && styles.before,
    side === 'after' && styles.after,
  );
  return (
    <div
      className={className}
      aria-hidden={side === undefined ? undefined : true}
      inert={side !== undefined}
    >
      {/* key を日付にして、日を動いたら、作り直す。上部の欄のスクロール位置を、先頭に戻すため。
          両方の日に欄があると、同じ DOM が使い回され、前の日のスクロール位置が残る。 */}
      <BannerList key={date} items={items.banner} />
      <div className={styles.paneBody}>
        <div ref={scrollerRef} className={styles.scroller} {...scrollerProps}>
          <Timeline
            items={items.timeline}
            placements={placements}
            date={date}
            onTrackClick={onTrackClick}
          />
        </div>
      </div>
    </div>
  );
}

function ignoreClick(): void {
  // 隣の日は、見せるだけ（pointer-events: none）。押せない。
}

/**
 * スワイプで見えてくる、隣の日。動かしている間だけ描く。位置は、切り替わったあとの見ている日と同じ
 * （topPixelsFor）にしておく。切り替わる瞬間に、位置が跳ばないため。
 */
export function NeighborPane({
  date,
  entries,
  display,
  side,
}: {
  date: DateStr;
  entries: readonly Entry[];
  display: WorkspaceDisplay;
  side: 'before' | 'after';
}) {
  const items = useMemo(() => dayItemsOf({ entries, display, date }), [entries, display, date]);
  const placements = useMemo(() => placementsOf(items.timeline), [items.timeline]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const firstItemStart = firstItemStartOf(items.timeline);
  useLayoutEffect(() => {
    if (scrollerRef.current !== null)
      scrollerRef.current.scrollTop = topPixelsFor(date, firstItemStart);
  }, [date, firstItemStart]);
  return (
    <DayPane
      date={date}
      items={items}
      placements={placements}
      scrollerRef={scrollerRef}
      onTrackClick={ignoreClick}
      side={side}
    />
  );
}
