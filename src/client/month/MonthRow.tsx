import { memo } from 'react';
import { dateToYmd, dayOfWeek, type DateStr } from '../../shared/date';
import { classNames } from '../classNames';
import { formatMonthDay } from '../dateFormat';
import { Link } from '../Link';
import { dayPath } from '../route';
import { cellBoundary } from './boundaries';
import { readableTextColor } from './color';
import { dayLabelParts } from './labels';
import type { BarItem, MoreItem, TimedItem } from './layout';
import styles from './MonthRow.module.css';
import { DATE_HEADER_HEIGHT, SLOT_HEIGHT } from './sizing';
import type { DayView, WeekView } from './weekViewCache';

const SUNDAY = 0;
const SATURDAY = 6;

function boundaryClass({ top, left }: ReturnType<typeof cellBoundary>): string {
  return classNames(
    top === 'month' && styles.topMonth,
    top === 'year' && styles.topYear,
    left === 'month' && styles.leftMonth,
    left === 'year' && styles.leftYear,
  );
}

function DayCell({ day, today }: { day: DayView; today: DateStr }) {
  const { day: dayOfMonth } = dateToYmd(day.date);
  const weekday = dayOfWeek(day.date);

  if (!day.inRange) {
    // 範囲（1900〜2199 年）の外の日。日表示へ移れない（URL が `/` に戻される）ので、リンクにしない。
    // ラベルと、月・年の境目の線も付けない（cellBoundary・dayLabelParts が、外の日は付けない）。日付の数字は薄く出す。
    return (
      <div className={classNames(styles.cell, styles.outOfRange)} aria-hidden="true">
        <span className={styles.dateLine} style={{ height: DATE_HEADER_HEIGHT }}>
          <span className={styles.number}>{dayOfMonth}</span>
        </span>
      </div>
    );
  }

  const label = dayLabelParts(day.date);
  const holiday = day.holidayName;
  const isToday = day.date === today;
  const numberClass = classNames(
    styles.number,
    isToday && styles.today,
    !isToday && holiday !== null && styles.holiday,
    !isToday && holiday === null && weekday === SUNDAY && styles.sunday,
    !isToday && holiday === null && weekday === SATURDAY && styles.saturday,
  );
  const names = [holiday, ...day.observanceNames].filter((name) => name !== null);
  // 読み上げ用。「10月22日（木） 祝日名」。曜日は、見出しの行（aria-hidden）からは読めないので、ここに入れる。
  const accessibleName = `${formatMonthDay(day.date)}${names.length > 0 ? ` ${names.join('・')}` : ''}`;

  return (
    <Link
      to={dayPath(day.date)}
      className={classNames(styles.cell, boundaryClass(cellBoundary(day.date)))}
      aria-label={accessibleName}
      aria-current={isToday ? 'date' : undefined}
    >
      <span className={styles.dateLine} style={{ height: DATE_HEADER_HEIGHT }}>
        <span className={numberClass}>{dayOfMonth}</span>
        {label !== null && (
          <span className={styles.monthLabel}>
            {label.year !== null && <span className={styles.labelYear}>{label.year}</span>}
            {label.month}
          </span>
        )}
        {holiday !== null && <span className={styles.holidayName}>{holiday}</span>}
        {day.observanceNames.map((name) => (
          <span key={name} className={styles.observanceName}>
            {name}
          </span>
        ))}
      </span>
    </Link>
  );
}

function BarChip({ item }: { item: BarItem }) {
  const { event } = item;
  return (
    <div
      className={classNames(
        styles.bar,
        item.continuesBefore && styles.continuesBefore,
        item.continuesAfter && styles.continuesAfter,
      )}
      style={{
        gridColumn: `${String(item.startCol + 1)} / ${String(item.endCol + 2)}`,
        gridRow: item.row + 1,
        backgroundColor: event.color,
        color: readableTextColor(event.color),
      }}
    >
      {event.title}
    </div>
  );
}

function TimedChip({ item }: { item: TimedItem }) {
  const { event } = item;
  return (
    <div className={styles.timed} style={{ gridColumn: item.col + 1, gridRow: item.row + 1 }}>
      <span className={styles.dot} style={{ backgroundColor: event.color }} />
      {event.startTime !== null && <span className={styles.time}>{event.startTime}</span>}
      <span className={styles.timedText}>{event.title}</span>
    </div>
  );
}

function MoreLink({ item, date }: { item: MoreItem; date: DateStr }) {
  return (
    <Link
      to={dayPath(date)}
      className={styles.more}
      style={{ gridColumn: item.col + 1, gridRow: item.row + 1 }}
      // 「+2件」だけでは、どの日の何なのかが、読み上げで分からない。
      aria-label={`${formatMonthDay(date)}の予定、ほか ${String(item.count)} 件`}
    >
      +{item.count}件
    </Link>
  );
}

interface MonthRowProps {
  view: WeekView;
  /** マスに入る予定の行数。 */
  slots: number;
  today: DateStr;
}

/**
 * 1 週間の行。同じ view・slots・today なら、描き直さない（スクロールで、行が出入りするときに、残る行を描き直さないため）。
 * 日付のマスは、リンクの全面（日付・空いているところ → 日表示。MV-8）。予定は、その上に重ねる。
 * 予定の層は、空いているところのクリックを下のマスに通す（pointer-events）。予定そのものは、今は何もしない
 * （フォームは実装 #8）。
 */
export const MonthRow = memo(function MonthRow({ view, slots, today }: MonthRowProps) {
  return (
    <div className={styles.row}>
      <div className={styles.cells}>
        {view.days.map((day) => (
          <DayCell key={day.date} day={day} today={today} />
        ))}
      </div>
      <div
        className={styles.events}
        style={{
          top: DATE_HEADER_HEIGHT,
          gridTemplateRows: `repeat(${String(slots)}, ${String(SLOT_HEIGHT)}px)`,
        }}
      >
        {view.items.map((item) => {
          switch (item.kind) {
            case 'bar':
              return <BarChip key={`${item.event.key}:${String(item.startCol)}`} item={item} />;
            case 'timed':
              return <TimedChip key={item.event.key} item={item} />;
            case 'more': {
              const day = view.days[item.col];
              return day === undefined ? null : (
                <MoreLink key={`more:${String(item.col)}`} item={item} date={day.date} />
              );
            }
          }
        })}
      </div>
    </div>
  );
});
