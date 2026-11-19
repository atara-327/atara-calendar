import { Suspense } from 'react';
import { FormLoadBoundary } from './FormLoadBoundary';
import { useFormState } from './instance';
import { LazyEntryForm } from './lazyEntryForm';
import { MoveDialog } from './MoveDialog';

/** 開いているフォームを出す。閉じているときは何も出さない。 */
export function FormHost() {
  const target = useFormState((state) => state.target);
  const session = useFormState((state) => state.session);
  // 開くたびに作り直す。key がないと、続けて別の予定を開いたとき、前の入力値が残る。
  // 境界は、閉じているときも置く（読み込みに失敗してフォームが閉じたあとも、知らせを出し続けるため）。
  return (
    <FormLoadBoundary key={session}>
      {target === null ? null : target.mode === 'move' ? (
        <MoveDialog target={target} />
      ) : (
        // 読み込み中は何も出さない。先読みしてあるので、出るのは先読みの前に開いたときだけで、すぐ終わる。
        <Suspense fallback={null}>
          <LazyEntryForm target={target} />
        </Suspense>
      )}
    </FormLoadBoundary>
  );
}
