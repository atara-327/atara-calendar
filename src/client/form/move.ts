import type { Occurrence } from '../../shared/recurrence';
import type { Entry, EntryChanges, Scope } from '../../shared/schema';
import { getSyncEngine } from '../sync/instance';
import { getFormController } from './instance';
import { scopeUnavailableMessage, unavailableMessage } from './messages';
import { decideScope } from './scope';

// ドラッグで時刻を移したあとの保存（EV-6。設計書 11.3）。フォームで時刻を変えて保存したときと同じ、
// decideScope で範囲を決め、エンジンの changeEntry で保存する（EntryForm.tsx の saveEdit と同じ道）。

export type MovePlan =
  /** 繰り返さない予定。範囲を聞かずに保存する。 */
  | { kind: 'save' }
  | { kind: 'ask'; scopes: readonly [Scope, ...Scope[]] }
  | { kind: 'reject'; message: string };

export function planMove({
  rows,
  occurrence,
  changes,
}: {
  rows: Iterable<Entry>;
  occurrence: Occurrence;
  changes: EntryChanges;
}): MovePlan {
  const decision = decideScope({ rows, occurrence, action: { kind: 'change', changes } });
  switch (decision.kind) {
    case 'single':
      return { kind: 'save' };
    case 'choose':
      return { kind: 'ask', scopes: decision.scopes };
    default:
      return { kind: 'reject', message: scopeUnavailableMessage(decision) };
  }
}

/**
 * 回の開始・終了の時刻を変えて保存する。繰り返さない予定は、その場で保存する。繰り返す予定は、範囲を聞く
 * ダイアログを開く。保存できないとき（読み込み中・範囲がない）は、理由を出すダイアログを開く
 * （Why not 黙って元に戻す: 動かしたのに保存されないことが、分からないため）。
 */
export function moveOccurrence(occurrence: Occurrence, changes: EntryChanges): void {
  const controller = getFormController();
  const open = (scopes: readonly Scope[] | null, message: string | null) => {
    controller.open({
      mode: 'move',
      occurrence,
      changes,
      scopes,
      message,
      openedAt: Date.now(),
    });
  };
  try {
    const engine = getSyncEngine();
    const plan = planMove({
      rows: engine.store.getState().view.entries.values(),
      occurrence,
      changes,
    });
    if (plan.kind === 'ask') {
      open(plan.scopes, null);
      return;
    }
    if (plan.kind === 'reject') {
      open(null, plan.message);
      return;
    }
    const { seriesId, occurrenceDate } = occurrence;
    const accepted = engine.changeEntry({ seriesId, occurrenceDate, scope: 'all' }, changes);
    if (accepted === null) open(null, unavailableMessage(engine.store.getState().phase, '保存'));
  } catch (error) {
    console.error('予定を保存できませんでした', error);
    open(null, '保存できませんでした');
  }
}
