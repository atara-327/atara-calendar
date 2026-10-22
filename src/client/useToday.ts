import { useSyncExternalStore } from 'react';
import { todayJst } from '../shared/date';
import type { DateStr } from '../shared/date';

// 日付が変わったら、「今日」の印と「今日」ボタンの行き先を変える。
// 日付が変わる瞬間に 1 回だけ動くタイマーにしないのは、タブが裏に回ると、ブラウザがタイマーを
// 遅らせるため。1 分ごとに今日を見て、タブが前面に戻ったときにも見る。値が変わらなければ、再描画されない。
const CHECK_INTERVAL_MS = 60_000;

function subscribe(onChange: () => void): () => void {
  const timer = window.setInterval(onChange, CHECK_INTERVAL_MS);
  document.addEventListener('visibilitychange', onChange);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onChange);
  };
}

function getToday(): DateStr {
  return todayJst();
}

/** 日本時間の今日。端末のタイムゾーンは見ない。 */
export function useToday(): DateStr {
  return useSyncExternalStore(subscribe, getToday);
}
