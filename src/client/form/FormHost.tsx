import { Suspense } from 'react';
import { useFormState } from './instance';
import { LazyEntryForm } from './lazyEntryForm';
import { MoveDialog } from './MoveDialog';

/** 開いているフォームを出す。閉じているときは何も出さない。 */
export function FormHost() {
  const target = useFormState((state) => state.target);
  const session = useFormState((state) => state.session);
  if (target === null) return null;
  if (target.mode === 'move') return <MoveDialog key={session} target={target} />;
  // 開くたびに作り直す。key がないと、続けて別の予定を開いたとき、前の入力値が残る。
  // 読み込み中は何も出さない。先読みしてあるので、出るのは先読みの前に開いたときだけで、すぐ終わる。
  return (
    <Suspense fallback={null}>
      <LazyEntryForm key={session} target={target} />
    </Suspense>
  );
}
