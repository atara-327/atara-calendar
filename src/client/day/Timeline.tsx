import type { MouseEvent } from 'react';
import { todayJst, utcMsToJstMinuteOfDay, type DateStr } from '../../shared/date';
import { classNames } from '../classNames';
import { readableTextColor } from '../color';
import { EmojiText } from '../emoji/EmojiText';
import { openEditForm } from '../form/instance';
import type { TimelineItem } from './dayItems';
import type { DayPlacement } from './layout';
import { HOUR_LABELS, MIN_ITEM_HEIGHT, PX_PER_MINUTE, TWO_LINE_HEIGHT } from './timelineGeometry';
import styles from './Timeline.module.css';
import { useNowMinute } from './useNowMinute';

function percent(ratio: number): string {
  return `${String(ratio * 100)}%`;
}

function TimelineButton({ item, placement }: { item: TimelineItem; placement: DayPlacement }) {
  // 時刻は 15 分刻みで、終了は開始より後なので、15px より低くはならない。念のための下限。
  const height = Math.max(MIN_ITEM_HEIGHT, (item.end - item.start) * PX_PER_MINUTE);
  return (
    <button
      type="button"
      aria-label={item.accessibleName}
      className={classNames(
        styles.item,
        item.color === null && styles.block,
        height < TWO_LINE_HEIGHT && styles.compact,
      )}
      // 位置と大きさは、時刻と重なりから、実行時に決まる。ワークスペースの色も同じ。CSP の下でも使える
      // React の style（CSSOM）で与える（設計書 11.2）。タイムブロックは、固定の色なので、CSS Modules。
      style={{
        top: item.start * PX_PER_MINUTE,
        height,
        left: percent(placement.column / placement.columns),
        width: percent(1 / placement.columns),
        ...(item.color === null
          ? {}
          : { backgroundColor: item.color, color: readableTextColor(item.color) }),
      }}
      onClick={() => {
        openEditForm(item.occurrence);
      }}
    >
      <span className={styles.itemTitle}>
        <EmojiText text={item.title} />
      </span>
      {height >= TWO_LINE_HEIGHT && <span className={styles.itemTime}>{item.timeLabel}</span>}
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
        {items.map((item, index) => {
          const placement = placements[index];
          return placement === undefined ? null : (
            <TimelineButton key={item.key} item={item} placement={placement} />
          );
        })}
        <NowLine date={date} />
      </div>
    </div>
  );
}
