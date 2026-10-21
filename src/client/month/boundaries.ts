import { dateToYmd, dayOfWeek, type DateStr } from '../../shared/date';

/** マスの境目の線の種類。none は、普通のマス目の線だけ。 */
export type LineKind = 'none' | 'month' | 'year';

export interface CellBoundary {
  /** マスの上側の線。 */
  top: LineKind;
  /** マスの左側の線。 */
  left: LineKind;
}

const DAYS_IN_FIRST_ROW_OF_STAIRS = 7;
const SUNDAY = 0;

/**
 * 月・年の境目の階段状の線のうち、そのマスが持つ分（MV-3・MV-4。設計書 11.2）。
 * 各月の 1 日のマスは左側に、各月の 1〜7 日のマスは上側に線を持つと、つながって階段になる。
 * 年の境目（1 月）は、月の境目より目立つ線にする。
 * 日曜日の 1 日は、行の左端で、左に隣のマスがないので、左側の線を持たない（画面の端に、孤立した縦線が出るため）。
 */
export function cellBoundary(date: DateStr): CellBoundary {
  const { month, day } = dateToYmd(date);
  const kind: LineKind = month === 1 ? 'year' : 'month';
  return {
    top: day <= DAYS_IN_FIRST_ROW_OF_STAIRS ? kind : 'none',
    left: day === 1 && dayOfWeek(date) !== SUNDAY ? kind : 'none',
  };
}
