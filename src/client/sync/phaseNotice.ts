import type { SyncPhase } from './state';

// 読み込みの状態の知らせ（設計書 6.5・11.2）。月表示・日表示の上端に重ねて出す SyncOverview と、
// サイドメニューが、同じ文言を出す。文言を 1 か所に置くのは、書き写すと、片方だけを直して食い違うため。

export type PhaseNotice = 'takenOver' | 'loadFailed' | 'loading';

export const PHASE_NOTICE_MESSAGES: Record<PhaseNotice, string> = {
  takenOver: '別のタブで開いたため、このタブは止めました',
  loadFailed: '読み込めませんでした',
  loading: '読み込み中…',
};

/**
 * 出す知らせ。読み込めていて動いている（ready）ときは null。
 * 別のタブで開いたため止めた（設計書 6.7）ときと、読み込めなかったときは、それぞれの知らせ。
 * それ以外の、まだ ready でない状態（起動中・読み込み中）は、読み込み中。
 */
export function phaseNotice(phase: SyncPhase, takenOver: boolean): PhaseNotice | null {
  if (phase === 'ready') return null;
  if (phase === 'stopped' && takenOver) return 'takenOver';
  if (phase === 'loadFailed') return 'loadFailed';
  return 'loading';
}
