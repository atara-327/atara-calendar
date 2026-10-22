import type { SyncPhase } from '../sync/state';
import type { ScopeDecision } from './scope';

/**
 * エンジンが、保存・削除を受け付けなかったとき（null を返したとき）に、フォームに出す理由。
 * 受け付けないのは、最初の読み込みが終わっていないとき（読み込み中・読み込めなかった）と、別のタブで開いたため、
 * このタブを止めたとき（設計書 6.7）。フォームは、閉じない（入力を失わないため）。
 */
export function unavailableMessage(phase: SyncPhase, action: '保存' | '削除'): string {
  if (phase === 'stopped') {
    return `別のタブで開いたため、このタブは止まっています。ページを開き直してから、もう一度${action}してください`;
  }
  return `読み込みが終わっていないため、${action}できませんでした。しばらくしてから、もう一度お試しください`;
}

/**
 * 範囲を決められなかったときに、フォームに出す理由（scope.ts の decideScope）。フォームは、閉じない（入力を失わないため）。
 * ruleAndDate は、ユーザーの回答（実装 #8 の確認 Q3。設計書 11.4）の文言。
 */
export function scopeUnavailableMessage(
  decision: Extract<ScopeDecision, { kind: 'gone' | 'unavailable' }>,
): string {
  if (decision.kind === 'gone') return 'この予定は、ほかの端末で変更・削除されました';
  return decision.reason === 'ruleAndDate'
    ? '繰り返しを毎日・平日・休日に変えるときは、日付を同時に変えられません。片方ずつ保存してください'
    : 'この組み合わせの変更は保存できません';
}

/**
 * 範囲を聞く段を開いている間に、ほかの端末の変更が届いて、選んだ範囲が、もう選べなくなったときの理由。
 * フォームの入力の段に戻る。もう一度保存（削除）すると、今の行で、選べる範囲を決め直す。
 */
export function scopeChangedMessage(action: '保存' | '削除'): string {
  return `ほかの端末の変更で、選んだ範囲では${action}できなくなりました。もう一度${action}して、範囲を選び直してください`;
}
