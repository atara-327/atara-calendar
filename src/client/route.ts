import type { DateStr } from '../shared/date';
import { inputDateSchema } from '../shared/schema';

/** 画面の切り替え先。月表示は `/`、日表示は `/day/YYYY-MM-DD`（設計書 11.1）。 */
export type Route = { name: 'month' } | { name: 'day'; date: DateStr };

const DAY_PATH = /^\/day\/(\d{4}-\d{2}-\d{2})$/;

/**
 * URL のパスを、画面の切り替え先にする。
 * 形が正しくない・存在しない日付・範囲（1900〜2199 年）の外は、null を返す。呼び出し側が `/` に戻す。
 * `/` と `/day/YYYY-MM-DD` 以外のパス（末尾の `/` つきも含む）も null。
 */
export function parseRoute(pathname: string): Route | null {
  if (pathname === '/') return { name: 'month' };
  const date = DAY_PATH.exec(pathname)?.[1];
  if (date === undefined) return null;
  // 2026-02-30 のような存在しない日付と、範囲（1900〜2199 年）の外の日付は、形が合っていても通さない。
  // 範囲の判定は、API の入力と同じ（shared の inputDateSchema）。画面だけ別の判定にすると、食い違う。
  if (!inputDateSchema.safeParse(date).success) return null;
  return { name: 'day', date };
}

export const MONTH_PATH = '/';

export function dayPath(date: DateStr): string {
  return `/day/${date}`;
}
