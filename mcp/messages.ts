import type { ApiErrorKind } from '../src/shared/api';
import type { ApiFailure, WriteOutcome } from './apiClient';

// Claude が利用者に伝えられる、短い日本語の文言（設計書 13.4）。
// サーバーの message は使わない。固定の短い文言で、画面向けの言い方のため、MCP の文脈（どのツールで直すか）に合わせて、ここで決める。

export interface ToolResult {
  /** false なら、依頼は反映されていない（または、反映されたか分からない）。 */
  ok: boolean;
  text: string;
}

const CLIENT_ERROR_MESSAGES: Record<ApiErrorKind, string> = {
  invalid_request:
    '入力が受け付けられませんでした（形式・範囲・項目の組み合わせが合っていません）。内容を見直してください',
  invalid_change:
    'その変更は受け付けられません（例: 「この予定のみ」では繰り返しを変えられません。「これ以降すべて」か「すべて」にしてください）',
  builtin_workspace: '組み込みのワークスペース（祝日・記念日）は、変更できず、予定も入れられません',
  last_workspace: '最後の 1 つのワークスペースは削除できません',
  edited_at_in_future:
    'この PC の時計が進んでいるようです。時刻を合わせてから、もう一度試してください',
  conflict:
    '保存されているデータと食い違っています（存在しないワークスペースを指している、同じ id がすでにある、など）。list_workspaces で確かめてください',
  not_found: 'API が見つかりません。拡張機能の設定の「ベース URL」を確かめてください',
  internal_error: 'サーバーでエラーが起きました。しばらくしてから、もう一度試してください',
};

const AUTH_MESSAGE =
  '認証に失敗しました。拡張機能の設定の Client ID と Client Secret（Cloudflare のサービストークン）を確かめてください';

/** 書き込みではない呼び出し（読み取り）の失敗。送り直しをしていないので、そのまま伝える。 */
export function describeFailure(failure: ApiFailure): string {
  switch (failure.kind) {
    case 'network':
      return '通信に失敗しました。ネットワークとベース URL を確かめてください';
    case 'server':
      return `サーバーが応答できませんでした（HTTP ${String(failure.status)}）。しばらくしてから、もう一度試してください`;
    case 'auth':
      return AUTH_MESSAGE;
    case 'unreadable':
      return 'サーバーの応答を読めませんでした';
    case 'client':
      return failure.error === null
        ? `リクエストが受け付けられませんでした（HTTP ${String(failure.status)}）`
        : CLIENT_ERROR_MESSAGES[failure.error];
  }
}

const CHECK_WITH_LIST_EVENTS = 'list_events で確かめてから、必要ならもう一度依頼してください';

const TRANSPORT_UNCERTAIN = `通信に失敗しました（1 回送り直しました）。反映されたかどうか分かりません。${CHECK_WITH_LIST_EVENTS}`;

const UNREADABLE_UNCERTAIN = `サーバーの応答を読めませんでした。反映されたかどうか分かりません。${CHECK_WITH_LIST_EVENTS}`;

/**
 * 書き込みの結果を、利用者に伝える文言にする。
 * done は、反映されたときの文言（何を作った・変えた・消したか）。
 */
export function describeWrite(outcome: WriteOutcome, done: string): ToolResult {
  switch (outcome.kind) {
    case 'applied':
      return { ok: true, text: done };
    case 'dropped':
      if (outcome.reason === 'not_found') {
        return { ok: false, text: '対象の予定（またはワークスペース）が見つかりません' };
      }
      return {
        ok: false,
        text: outcome.retried
          ? '反映済みか、ほかの端末の新しい編集があったため、反映しませんでした。list_events で確かめてください'
          : 'ほかの端末の新しい編集があったため、反映しませんでした',
      };
    case 'failed': {
      const { failure, retried } = outcome;
      if (failure.kind === 'unreadable') return { ok: false, text: UNREADABLE_UNCERTAIN };
      if (retried && (failure.kind === 'network' || failure.kind === 'server')) {
        return { ok: false, text: TRANSPORT_UNCERTAIN };
      }
      // 送り直したあとの失敗。1 回目が保存されていた（応答だけが失われた）かもしれない。
      return {
        ok: false,
        text: retried
          ? `${describeFailure(failure)}。1 回目の送信は、反映されたかもしれません。${CHECK_WITH_LIST_EVENTS}`
          : describeFailure(failure),
      };
    }
  }
}
