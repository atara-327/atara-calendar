import { useStore } from 'zustand';
import type { Occurrence } from '../../shared/recurrence';
import { createFormController, type FormController, type FormState } from './formController';
import type { EntryKind } from './values';

let controller: FormController | null = null;

/**
 * 画面で使う、フォームの状態（1 つだけ）。最初に呼ばれたときに作る。
 * 作るのを、モジュールの読み込み時にしないのは、読み込んだだけで、window に触れないため（sync/instance.ts と同じ）。
 */
export function getFormController(): FormController {
  controller ??= createFormController({
    history: window.history,
    onPopState: (listener) => {
      window.addEventListener('popstate', listener);
      return () => {
        window.removeEventListener('popstate', listener);
      };
    },
  });
  return controller;
}

/** 新しい予定・タイムブロックのフォームを開く。開始の初期値の「今」は、開いた時刻。 */
export function openCreateForm(kind: EntryKind): void {
  getFormController().open({ mode: 'create', kind, openedAt: Date.now() });
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
