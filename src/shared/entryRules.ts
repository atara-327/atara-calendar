import { isDateInSupportedYears, type Entry } from './schema';

// 項目をまたぐ確認（設計書 4.2）。スキーマに入れないのは、z.object に refine を付けると、下書きや変更の
// スキーマを pick / omit で導けなくなるため（schema.ts）。API の入力と、サーバーが計算した書く行の両方に当てる。
// 書く行にも当てるのは、「すべて」の変更などで、変えていない項目との組み合わせが合わなくなることがあるため
// （例: 終日にしたのに、時刻を null にしていない）。
// shared に置くのは、画面のフォームが、保存の前に、サーバーと同じ決まりで確かめるため（設計書 11.4）。
// 画面にだけ同じ決まりを書くと、片方だけを直して食い違い、フォームを通った入力を、サーバーが 400 で断ってしまう。

type RuleFields = Pick<
  Entry,
  | 'kind'
  | 'workspaceId'
  | 'allDay'
  | 'startDate'
  | 'startTime'
  | 'endDate'
  | 'endTime'
  | 'rrule'
  | 'untilDate'
>;

/** 守られていない決まりがあれば、その説明（ログ用）。なければ null。 */
export function entryProblem(entry: RuleFields): string | null {
  // 入力の年の確認（schema.ts の inputDateSchema）は、依頼の値にしか効かない。サーバーが計算した行は、
  // 日付をずらす途中で範囲を出ることがある（例: 2199-12-31 から始まる「毎週 月」は、開始日が 2200 年に
  // ずれる）。出たまま保存すると、展開が回を 1 つも出さない系列になる（設計書 4.2）。
  for (const date of [entry.startDate, entry.endDate, entry.untilDate]) {
    if (date !== null && !isDateInSupportedYears(date)) return `日付の年が範囲外です（${date}）`;
  }

  // 終わりの日が開始日より前の系列は、回が 1 つもなく、展開が何も出さないので、画面から直せない（設計書 4.2）。
  // 回を数えて確かめずに、日付を比べるだけにするのは、開始日が、ルールに合う日にそろえてあるため（normalizeStart）。
  // ルールがない行は見ない。その行の untilDate は展開に使われず、ルールをなくす変更は untilDate を null にする
  // （recurrence.ts の changeAll・changeFollowing）。
  if (entry.rrule !== null && entry.untilDate !== null && entry.untilDate < entry.startDate) {
    return '繰り返しの終わりの日が、開始日より前です';
  }

  if (entry.kind === 'block') {
    if (entry.allDay) return 'タイムブロックは終日にできません';
    if (entry.workspaceId !== null) return 'タイムブロックはワークスペースを持てません';
  } else if (entry.workspaceId === null) {
    return '予定にはワークスペースが必要です';
  }

  if (entry.allDay) {
    if (entry.startTime !== null || entry.endTime !== null) return '終日の予定に時刻があります';
    // 終日の終了日は最終日（その日を含む）なので、1 日だけの予定は、開始日と終了日が同じになる。
    if (entry.endDate < entry.startDate) return '終了日が開始日より前です';
    return null;
  }

  if (entry.startTime === null || entry.endTime === null) {
    return '時間指定の予定に時刻がありません';
  }
  // 日付と時刻をつないだ文字列は、'YYYY-MM-DDTHH:MM' で、文字列の大小が日時の前後と一致する。
  if (`${entry.endDate}T${entry.endTime}` <= `${entry.startDate}T${entry.startTime}`) {
    return '終了が開始より後になっていません';
  }
  return null;
}
