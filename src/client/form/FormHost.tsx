import { EntryForm } from './EntryForm';
import { useFormState } from './instance';

/** 開いているフォームを出す。閉じているときは何も出さない。 */
export function FormHost() {
  const target = useFormState((state) => state.target);
  const session = useFormState((state) => state.session);
  if (target === null) return null;
  // 開くたびに作り直す。key がないと、続けて別の予定を開いたとき、前の入力値が残る。
  return <EntryForm key={session} target={target} />;
}
