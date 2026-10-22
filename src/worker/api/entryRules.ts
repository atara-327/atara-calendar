import { entryProblem } from '../../shared/entryRules';
import type { Entry } from '../../shared/schema';
import { badRequest } from './errors';

// 書く行の確認（設計書 4.2）。確かめる決まり（項目をまたぐ確認）は、画面のフォームも同じものを使うので、
// shared/entryRules.ts にある。ここは、その決まりを、書く行のすべてに当てて、守られていなければ 400 にする。
// 書く行にも当てるのは、「すべて」の変更などで、変えていない項目との組み合わせが合わなくなることがあるため
// （例: 終日にしたのに、時刻を null にしていない）。

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
