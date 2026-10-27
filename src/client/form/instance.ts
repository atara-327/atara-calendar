import { useStore } from 'zustand';
import type { Occurrence } from '../../shared/recurrence';
import { browserHistoryEnv } from '../historyMark';
import { createFormController, type FormController, type FormState } from './formController';
import type { StartPoint } from './schedule';
import type { EntryKind } from './values';

let controller: FormController | null = null;

/**
 * 画面で使う、フォームの状態（1 つだけ）。最初に呼ばれたときに作る。
 * 作るのを、モジュールの読み込み時にしないのは、読み込んだだけで、window に触れないため（sync/instance.ts と同じ）。
 */
export function getFormController(): FormController {
  controller ??= createFormController(browserHistoryEnv());
  return controller;
}

/**
 * 新しい予定・タイムブロックのフォームを開く。start を渡すと、そこから 1 時間が、開始と終了の初期値になる。
 * 渡さなければ、今日の次の正時から 1 時間（その「今」は、開いた時刻）。
 */
export function openCreateForm(kind: EntryKind, start?: StartPoint): void {
  getFormController().open({ mode: 'create', kind, openedAt: Date.now(), start });
}

/** 開いた回（月表示で押した予定）のフォームを開く。 */
export function openEditForm(occurrence: Occurrence): void {
  getFormController().open({ mode: 'edit', occurrence, openedAt: Date.now() });
}

export function closeEntryForm(): void {
  getFormController().close();
}

export function useFormState<T>(selector: (state: FormState) => T): T {
  return useStore(getFormController().store, selector);
}
