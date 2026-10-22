import { dateToYmd, dayOfWeek, type DateStr } from '../../shared/date';
import { normalizeStart } from '../../shared/recurrence';
import { inputDateSchema, type Entry, type Rrule } from '../../shared/schema';
import { formatDayTitle, formatMonthDay } from '../dateFormat';

// フォームの「繰り返し」の欄（設計書 11.4。要件 RP-1・RP-3・RP-5・RP-6）。画面に依存しない。
// 欄の値と rrule の相互の変換、開始日から作る説明、保存したときに開始日がずれることの先出しを決める。
// ずらす計算（normalizeStart）と、ルールが同じかの判定（isSameRrule。build.ts）は、サーバーと同じ shared の関数を使う。
// 画面に書き写すと、片方だけを直して食い違い、画面が「最初の回」と言った日と、保存された日がずれる。

/** 欄の選択肢。'none' は繰り返さない（rrule が null）。終わりの指定は出さない（RP-3）。 */
export type RepeatKind = 'none' | Rrule['freq'];

export const REPEAT_OPTIONS: readonly { kind: RepeatKind; label: string }[] = [
  { kind: 'none', label: 'しない' },
  { kind: 'daily', label: '毎日' },
  { kind: 'weekly', label: '毎週' },
  { kind: 'monthly', label: '毎月' },
  { kind: 'yearly', label: '毎年' },
  { kind: 'weekday', label: '平日' },
  { kind: 'holiday', label: '休日' },
];

export interface RepeatFields {
  repeat: RepeatKind;
  /**
   * 毎週の曜日（0 = 日曜 〜 6 = 土曜。昇順）。null は、まだ利用者が選んでいない状態で、開始日の曜日になる
   * （開始日を変えたら、曜日もついてくる。選んだあとは、ついてこない）。
   * Why not 最初から曜日を入れておく: 毎週を選んだあとで開始日を直すと、曜日が前の開始日のままで、
   * 「最初の回は…」が、意図しない日になるため。
   */
  repeatDays: readonly number[] | null;
}

export const NO_REPEAT: RepeatFields = { repeat: 'none', repeatDays: null };

type RepeatInput = RepeatFields & { startDate: string };

function isValidDate(date: string): boolean {
  return inputDateSchema.safeParse(date).success;
}

function sorted(days: readonly number[]): number[] {
  return [...days].sort((a, b) => a - b);
}

/**
 * 毎週の曜日（昇順）。選んでいなければ開始日の曜日。開始日が正しくなければ（日付を打っている途中）、空。
 * 昇順にそろえるのは、並びの違いを「ルールを変えた」と見なさないため（設計書 4.5。isSameRrule も並びを見ない）。
 */
export function weeklyDays({ repeatDays, startDate }: RepeatInput): number[] {
  if (repeatDays !== null) return sorted(repeatDays);
  return isValidDate(startDate) ? [dayOfWeek(startDate)] : [];
}

/** 欄の値から rrule を作る。繰り返さないなら null。 */
export function rruleOf(input: RepeatInput): Rrule | null {
  switch (input.repeat) {
    case 'none':
      return null;
    case 'weekly':
      return { freq: 'weekly', days: weeklyDays(input) };
    default:
      return { freq: input.repeat };
  }
}

/** 開いた予定の（系列の）rrule を、欄の値にする。 */
export function repeatFieldsOf(rrule: Rrule | null): RepeatFields {
  if (rrule === null) return NO_REPEAT;
  if (rrule.freq === 'weekly') return { repeat: 'weekly', repeatDays: sorted(rrule.days) };
  return { repeat: rrule.freq, repeatDays: null };
}

/**
 * 開いた回の、系列の rrule。回（Occurrence）はルールを持たないので、行から seriesId で系列の行を引く。
 * 例外の回も、系列のルールを返す（例外の行はルールを持たない）。繰り返さない予定は、自分の行のルール（null）。
 * 行が見つからなければ null（開いている間に、ほかの端末で消された。範囲を決めるとき、scope.ts が見つける）。
 */
export function seriesRruleOf(entries: ReadonlyMap<string, Entry>, seriesId: string): Rrule | null {
  return entries.get(seriesId)?.rrule ?? null;
}

/** 曜日のトグルを 1 つ切り替える。選んでいなかった状態（null）からは、開始日の曜日を起点にする。 */
export function toggleRepeatDay(input: RepeatInput, day: number): RepeatFields {
  const current = weeklyDays(input);
  const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
  return { repeat: input.repeat, repeatDays: sorted(next) };
}

/** 毎週で、曜日が 1 つも選ばれていない（保存できない誤り）。選んでいない（null）状態は、開始日の曜日なので誤りではない。 */
export function hasNoWeeklyDays({ repeat, repeatDays }: RepeatFields): boolean {
  return repeat === 'weekly' && repeatDays !== null && repeatDays.length === 0;
}

const WEEKDAY_DAYS_NOTE = '土曜・日曜・祝日・年末年始（12/29〜1/3）';

/**
 * 繰り返しの説明。毎月・毎年は、基準の日付（baseDate）から作る（設計書 4.4。基準は開始日）。
 * 平日・休日は、判定の決まり（RP-5）を添える。毎日・毎週と、しない、日付が正しくないときは null。
 */
export function describeRepeat(repeat: RepeatKind, baseDate: string): string | null {
  switch (repeat) {
    case 'monthly': {
      if (!isValidDate(baseDate)) return null;
      const { day } = dateToYmd(baseDate);
      // 29〜31 日がない月がある（RP-2）。
      return day >= 29
        ? `毎月 ${String(day)} 日（その日がない月は飛ばします）`
        : `毎月 ${String(day)} 日`;
    }
    case 'yearly': {
      if (!isValidDate(baseDate)) return null;
      const { month, day } = dateToYmd(baseDate);
      const text = `毎年 ${String(month)} 月 ${String(day)} 日`;
      // うるう年でない年は、2/29 がないので、飛ばす（設計書 Q9）。
      return month === 2 && day === 29 ? `${text}（うるう年だけ）` : text;
    }
    case 'weekday':
      return `${WEEKDAY_DAYS_NOTE}以外の日です。記念日は休日ではありません`;
    case 'holiday':
      return `${WEEKDAY_DAYS_NOTE}の日です。記念日は含みません`;
    default:
      return null;
  }
}

/**
 * 保存したときの、最初の回（設計書 4.4。開始日がルールに合わなければ、合う最初の日へずれる）。
 * - none: 繰り返さない、または日付がまだ正しくない（別の誤りが出る）、毎週で曜日がない（別の誤りが出る）。
 * - unsupported: ずらす途中で、日付の計算が対応する年（1900〜2199 年）を出る（例: 2199-12-31 の「平日」）。
 * - found: ずらした後の開始日と終了日。ずれないときは、入力のまま。
 */
export type FirstOccurrence =
  | { kind: 'none' }
  | { kind: 'unsupported' }
  | { kind: 'found'; startDate: DateStr; endDate: DateStr };

export function firstOccurrence(input: RepeatInput & { endDate: string }): FirstOccurrence {
  const rrule = rruleOf(input);
  const { startDate, endDate } = input;
  if (rrule === null || !isValidDate(startDate) || !isValidDate(endDate)) return { kind: 'none' };
  if (rrule.freq === 'weekly' && rrule.days.length === 0) return { kind: 'none' };
  try {
    return { kind: 'found', ...normalizeStart(rrule, { startDate, endDate }) };
  } catch (error) {
    // 祝日の計算が、対応外の年で投げる。サーバーも同じ計算で、同じ例外を 400 にする（設計書 5.1）。
    if (error instanceof RangeError) return { kind: 'unsupported' };
    throw error;
  }
}

/**
 * 「最初の回は 10月24日（水）になります」。開始日がずれるときだけ。ずれなければ null。
 * 開始日と年が違う日にずれるときは、年も付ける。
 */
export function describeFirstOccurrence(first: FirstOccurrence, startDate: string): string | null {
  if (first.kind !== 'found' || first.startDate === startDate) return null;
  const sameYear = first.startDate.slice(0, 4) === startDate.slice(0, 4);
  const label = sameYear ? formatMonthDay(first.startDate) : formatDayTitle(first.startDate);
  return `最初の回は ${label}になります`;
}
