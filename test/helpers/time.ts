import { jstToUtcMs } from '../../src/shared/date';

/** 日本時間の日付と 'HH:MM' から、UTC のミリ秒。通知の時刻の期待値を、読める形で書くため。 */
export function jst(date: string, time: string): number {
  return jstToUtcMs(date, Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)));
}
