import type { Occurrence } from '../shared/recurrence';
import { isInLiveWorkspace } from '../shared/workspace';
import {
  advanceNextNotifyAt,
  readDueEntries,
  readLiveWorkspaceIds,
  readSeriesEntries,
  type Database,
  type DueEntry,
} from './db/store';
import type { Bindings } from './env';
import { postToDiscord, type DiscordFetch } from './notify/discord';
import { buildNotifyMessage } from './notify/message';
import { nextNotifyTimes, occurrenceNotifiedAt } from './notify/nextNotifyAt';

// 1 分ごとの定期実行（scheduled）。時刻が来た行を探して、Discord に送り、次の回の時刻に進める（設計書 9.3）。

/**
 * 1 回の実行で処理する行数の上限。無料プランの CPU 時間は 1 回 10ms で、1 行の処理（系列の読み直し・計算・
 * 文面）が 0.2〜1.5ms ほどかかるため（設計書 付録 A.2）。残りは、次の分の実行が拾う。同じ時刻に 100 行より
 * 多く重ならない限り、遅れは、10 分の決まり（LATE_NOTIFY_LIMIT_MS）に収まる。
 */
export const MAX_DUE_ENTRIES_PER_RUN = 10;

/** 通知の時刻から、これ以上遅れた通知は、送らずに次の回へ進める（設計書 Q10）。 */
export const LATE_NOTIFY_LIMIT_MS = 10 * 60_000;

export interface NotifyRunOptions {
  /** Discord への送信に使う fetch。テストが、偽物を渡すために受け取る。 */
  fetchFn?: DiscordFetch;
}

// fetch を包むのは、オプションの fetchFn に、そのまま fetch を入れて options.fetchFn(...) と呼ぶと、this が
// options になり、Workers が「Illegal invocation」にするため。
const defaultFetch: DiscordFetch = (url, init) => fetch(url, init);

interface RunContext {
  db: Database;
  nowMs: number;
  liveWorkspaceIds: ReadonlySet<string>;
  /** 回の内容を、Discord に送る。送らないとき（Webhook の URL が未設定）は、ログだけ出す。 */
  deliver: (occurrence: Occurrence) => Promise<void>;
}

/**
 * 時刻が来た行 1 つの処理。
 * 先に next_notify_at を次の回に進めてから、送る（設計書 9.3）。逆だと、送ったあとで更新に失敗したときに、
 * 同じ通知が毎分届き続ける。この順なら、最悪でも「1 回届かない」で済む。
 */
async function processDueEntry(context: RunContext, due: DueEntry): Promise<void> {
  const { db, nowMs } = context;
  // 行ごとに、系列を読み直す。読んだ時刻が来てから、今までの間に、保存が行を変えたかもしれないため。
  const family = (await readSeriesEntries(db, due.familyId)).map(({ entry }) => entry);
  const occurrence = occurrenceNotifiedAt({
    family,
    rowId: due.id,
    notifyAt: due.nextNotifyAt,
  });

  if (occurrence === null) {
    // 送る回が、もうその行の回ではない。2 台でほぼ同時に操作した割り込み（設計書 6.4）で、古い値が残った。
    // 送らずに、今の展開で計算し直した値にする。
    const next = nextNotifyTimes({ family, afterMs: nowMs }).get(due.id) ?? null;
    await advanceNextNotifyAt(db, due.id, due.nextNotifyAt, next);
    return;
  }

  // 10 分以上遅れた回が続いても、一度で、遅れていない最初の回まで進むように、afterMs に、今の 10 分前を使う。
  // 読んだ値だけを使うと、遅れた回を 1 つずつ、毎分、進めることになる。
  const afterMs = Math.max(due.nextNotifyAt, nowMs - LATE_NOTIFY_LIMIT_MS);
  const next = nextNotifyTimes({ family, afterMs }).get(due.id) ?? null;
  const advanced = await advanceNextNotifyAt(db, due.id, due.nextNotifyAt, next);
  // 変わった行がなければ、別の実行か保存が、先に変えた。ここで送ると、二重に送るか、保存が決めた新しい値の前の回を送る。
  if (!advanced) return;

  if (nowMs - due.nextNotifyAt >= LATE_NOTIFY_LIMIT_MS) return;
  // 見るのは、削除されたワークスペースだけ。表示の ON/OFF は見ない（ユーザーの回答。設計書 9.2）。
  // 送らなくても、値は進めてある。進めないと、削除されたワークスペースの予定が、毎分、見つかり続ける。
  if (!occurrence.notifyEnabled || !isInLiveWorkspace(occurrence, context.liveWorkspaceIds)) return;
  await context.deliver(occurrence);
}

/**
 * 通知の時刻が来た行を送り、次の回の時刻に進める。now は、定期実行の予定の時刻（controller.scheduledTime）。
 * 1 行で例外が起きても、ほかの行は続ける。ログに出すのは、行の id と例外だけで、題名などの中身は出さない。
 * 壊れた行（CorruptRowError）で、その行の値が進まないときは、毎分、同じ例外のログが出る。それで気づける（付録 A.3）。
 */
export async function sendDueNotifications(
  env: Bindings,
  nowMs: number,
  { fetchFn = defaultFetch }: NotifyRunOptions = {},
): Promise<void> {
  const due = await readDueEntries(env.DB, nowMs, MAX_DUE_ENTRIES_PER_RUN);
  if (due.length === 0) return;

  const webhookUrl = env.DISCORD_WEBHOOK_URL?.trim();
  let missingWebhookLogged = false;
  const context: RunContext = {
    db: env.DB,
    nowMs,
    liveWorkspaceIds: await readLiveWorkspaceIds(env.DB),
    deliver: async (occurrence) => {
      if (webhookUrl === undefined || webhookUrl === '') {
        // 設定する前の通知が、設定した瞬間にまとめて届かないように、送らずに、値は進める。
        // ログは、1 回の実行で 1 回だけ。URL が未設定のときに、通知が出る行の数だけ出すと、うるさい。
        if (!missingWebhookLogged) {
          missingWebhookLogged = true;
          console.error(
            'DISCORD_WEBHOOK_URL が設定されていないので、通知を送りません（登録の手順は docs/setup.md）',
          );
        }
        return;
      }
      await postToDiscord({
        webhookUrl,
        content: buildNotifyMessage(occurrence, env.APP_ORIGIN),
        fetchFn,
      });
    },
  };

  for (const entry of due) {
    try {
      await processDueEntry(context, entry);
    } catch (error) {
      console.error(`通知の処理に失敗しました（行の id: ${entry.id}）`, error);
    }
  }
}

/** Worker の scheduled ハンドラ（wrangler.jsonc の triggers.crons。毎分）。 */
export async function scheduled(controller: ScheduledController, env: Bindings): Promise<void> {
  await sendDueNotifications(env, controller.scheduledTime);
}
