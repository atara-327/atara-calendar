import type { SyncPhase } from '../sync/state';

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
