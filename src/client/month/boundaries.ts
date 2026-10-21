import { dateToYmd, type DateStr } from '../../shared/date';

/** マスの境目の線の種類。none は、普通のマス目の線だけ。 */
export type LineKind = 'none' | 'month' | 'year';

export interface CellBoundary {
  /** マスの上側の線。 */
  top: LineKind;
  /** マスの左側の線。 */
  left: LineKind;
}

const DAYS_IN_FIRST_ROW_OF_STAIRS = 7;

/**
 * 月・年の境目の階段状の線のうち、そのマスが持つ分（MV-3・MV-4。設計書 11.2）。
 * 各月の 1 日のマスは左側に、各月の 1〜7 日のマスは上側に線を持つと、つながって階段になる。
 * 年の境目（1 月）は、月の境目より目立つ線にする。
 */
export function cellBoundary(date: DateStr): CellBoundary {
  const { month, day } = dateToYmd(date);
  const kind: LineKind = month === 1 ? 'year' : 'month';
  return {
    top: day <= DAYS_IN_FIRST_ROW_OF_STAIRS ? kind : 'none',
    left: day === 1 ? kind : 'none',
  };
}
