import { isDateInSupportedYears, type Entry } from '../../shared/schema';
import { badRequest } from './errors';

// 項目をまたぐ確認（設計書 4.2）。スキーマに入れないのは、z.object に refine を付けると、下書きや変更の
// スキーマを pick / omit で導けなくなるため（schema.ts）。API の入力と、サーバーが計算した書く行の両方に当てる。
// 書く行にも当てるのは、「すべて」の変更などで、変えていない項目との組み合わせが合わなくなることがあるため
// （例: 終日にしたのに、時刻を null にしていない）。

type RuleFields = Pick<
  Entry,
  | 'kind'
  | 'workspaceId'
  | 'allDay'
  | 'startDate'
  | 'startTime'
  | 'endDate'
  | 'endTime'
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

/**
 * 書く行を確かめる。合わなければ 400。削除する行（deletedAt がある行）は確かめない。
 * 確かめると、決まりが厳しくなる前に保存された行を、削除できなくなるため。
 * id の重複は、applyWrite が（呼び出し側のバグとして）プレーンな Error にするので、500 になって端末が
 * 再送し続けないよう、依頼の誤りとして先に 400 にする（例: 新しい行の id が、消す例外の行の id と同じ）。
 */
export function assertWritableEntries(entries: readonly Entry[]): void {
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
    throw badRequest('新しい行の id が、書き込む他の行の id と重なっています');
  }
  for (const entry of entries) {
    if (entry.deletedAt !== null) continue;
    const problem = entryProblem(entry);
    if (problem !== null) throw badRequest(`${problem}（id: ${entry.id}）`);
  }
}
