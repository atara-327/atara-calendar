import { replayRequests, type RowSet } from './replay';
import type { PendingRequest } from './requests';

/**
 * 同期の状態。
 * - idle: まだ動かしていない。starting: 錠を取り、送信待ちを読んでいる。loading: 最初の全データの読み込み中。
 * - ready: 読み込めて、見ることも編集することもできる。
 * - loadFailed: 最初の読み込みに失敗した（再試行できる）。電波がない状態で開いたとき（SY-4）もここに来る。
 * - stopped: 止めた。別のタブで開いたため（takenOver）か、止めるよう頼まれた。もう動かさない。
 */
export type SyncPhase = 'idle' | 'starting' | 'loading' | 'ready' | 'loadFailed' | 'stopped';

/** サーバーから受け取った内容。削除済みの行も、id で持つ（設計書 6.3）。 */
export interface BaseData extends RowSet {
  /** 最後に受け取った rev。GET /api/changes の応答の rev だけを覚える（書き込みの応答からは覚えない。設計書 6.3）。 */
  rev: number;
  /** 覚えている epoch。まだ受け取っていなければ null。違う値が届いたら、全データを読み込み直す（設計書 付録 A.1）。 */
  epoch: string | null;
}

/** 送信待ちの依頼。IndexedDB にも保存してある。 */
export interface QueuedRequest {
  /** 依頼の id。IndexedDB のキーと同じ。 */
  id: string;
  request: PendingRequest;
  /**
   * この時刻（ms）までは送らない。0 なら、すぐ送れる。削除の「元に戻す」の間（設計書 6.6）だけ、先の時刻になる。
   * IndexedDB には保存しない。再読み込みで開いたときは、元に戻すボタンがもうないので、待たずに送る。
   */
  sendAfter: number;
}

/**
 * 送信は終えたが、受け取りでまだ確かめていない依頼（設計書 6.4）。
 * 列から外れる（IndexedDB からも消える）が、画面に出すデータには、受け取りで確かめるまで重ね続ける。
 * Why: 200 を受け取ってから、その依頼の結果が、次の受け取りで届くまでの間、サーバーから受け取った内容には、
 * まだその依頼の結果がない。列から外した時点で重ねるのをやめると、編集した予定が、送信が終わった瞬間に
 * 画面から消え、受け取りが終わると、また現れる（画面がちらつく）。
 * 依頼のやり直しは、サーバーが反映済みなら（今の行の editedAt が依頼の editedAt 以上なので）何も当てない
 * ので、確かめるまで重ね続けても、結果は変わらない。
 */
export interface ConfirmingRequest {
  id: string;
  request: PendingRequest;
  /** この番号以降に始まった受け取りが成功すれば、確かめられたことになる（その受け取りは、200 の後に始まっている）。 */
  coverIndex: number;
}

export interface SyncState {
  phase: SyncPhase;
  /** 別のタブで開いたため、このタブを止めた（設計書 6.7。実装 #6 の確認 Q5）。phase が stopped のとき。 */
  takenOver: boolean;
  /** サーバーから受け取った内容。 */
  base: BaseData;
  /** 送信待ちの依頼。先頭から順に送る。 */
  queue: readonly QueuedRequest[];
  confirming: readonly ConfirmingRequest[];
  /**
   * 画面に出すデータ。base の上に、confirming と queue の依頼を、先頭から順にやり直した結果。
   * base・queue・confirming が変わるたびに作り直す。手元の編集結果を、base とは別にため込まない
   * （サーバーが捨てた依頼の結果が、手元にだけ残り続けないため。設計書 6.4）。
   */
  view: RowSet;
  /**
   * サーバーが断った（4xx）依頼、または形が合わずに消した依頼の、数。画面に知らせる（実装 #6 の確認 Q2）。
   * clockSkew は、edited_at_in_future で断られた依頼がある（端末の時計がずれている）。
   * 200 の applied: false（別の端末の新しい編集に負けた・対象がもうない）は、含めない。SY-3 どおりの正常な動き。
   */
  discarded: { count: number; clockSkew: boolean };
  /** ログインが切れている、または許可されていない（401・403・Access のログイン画面への転送。実装 #6 の確認 Q6）。 */
  authRequired: boolean;
  /** 受け取りの応答が、読める形でなかった（設計書 6.3）。 */
  syncError: boolean;
  /**
   * サーバーが失敗を返した（応答は返ってきたが、5xx など。設計書 6.5）。最後に返ってきた応答が失敗だったときの HTTP の状態。
   * 失敗でなければ null。通信の失敗（電波がない。応答がない）では変えない。
   * Why 送信と受け取りで分けて持つのか: 片方の成功で、もう片方の止まった失敗の知らせを消さないため。
   * たとえば、壊れた行を書き直す依頼が 500 で止まっている間も、受け取りは成功する。
   */
  serverFailure: { send: number | null; receive: number | null };
  /** この端末では、送信待ちを IndexedDB に保存できない。 */
  storageFailed: boolean;
}

export function emptyBase(): BaseData {
  return { rev: 0, epoch: null, workspaces: new Map(), entries: new Map() };
}

export function computeView(
  base: BaseData,
  confirming: readonly ConfirmingRequest[],
  queue: readonly QueuedRequest[],
): RowSet {
  return replayRequests(base, [
    ...confirming.map(({ request }) => request),
    ...queue.map(({ request }) => request),
  ]);
}

export function initialState(): SyncState {
  const base = emptyBase();
  return {
    phase: 'idle',
    takenOver: false,
    base,
    queue: [],
    confirming: [],
    view: base,
    discarded: { count: 0, clockSkew: false },
    authRequired: false,
    syncError: false,
    serverFailure: { send: null, receive: null },
    storageFailed: false,
  };
}

/** 「未送信 N件」の N。 */
export function selectPendingCount(state: SyncState): number {
  return state.queue.length;
}
