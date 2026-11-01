import { z } from 'zod';
import {
  MAX_OCCURRENCES_DAYS,
  deleteEntryRequestSchema,
  occurrencesResponseSchema,
  patchEntryRequestSchema,
  putEntryRequestSchema,
  putWorkspaceRequestSchema,
} from '../src/shared/api';
import { addDays, dateToDays, type DateStr } from '../src/shared/date';
import { entryProblem } from '../src/shared/entryRules';
import { defaultNotify } from '../src/shared/notifyDefaults';
import type { Occurrence } from '../src/shared/recurrence';
import type { EntryDraft, Scope } from '../src/shared/schema';
import { structuralWorkspaceSchema } from '../src/shared/structure';
import { selectableWorkspaces } from '../src/shared/workspace';
import { WORKSPACE_COLORS, firstUnusedColor, isSameColor } from '../src/shared/workspaceColors';
import { callApi, sendWrite, type ApiEnv, type ApiFailure } from './apiClient';
import { describeFailure, describeWrite, type ToolResult } from './messages';
import {
  MAX_LIST_DAYS,
  type CreateEventInput,
  type CreateWorkspaceInput,
  type DeleteEventInput,
  type ListEventsInput,
  type UpdateEventInput,
} from './toolSchemas';

// 6 つのツール（設計書 13.3）の中身。MCP の SDK には依存しない（server.ts が、入力の検証と結果の包みを受け持つ）。
// 判断（期間の区切り・色の選び方・editedAt・送り直し）をここと、apiClient.ts・editedAtClock.ts に置き、
// fetch・時計・UUID は引数で差し替えて、テストできるようにする。

export interface ToolDeps {
  api: ApiEnv;
  /** 新しい行の id（PUT の :id、PATCH・DELETE の newId）に使う UUID。 */
  newId: () => string;
  /** 書き込みの editedAt。editedAtClock.ts。 */
  nextEditedAt: () => number;
}

const SCOPE_LABELS: Record<Scope, string> = {
  this: 'この予定のみ',
  following: 'これ以降すべて',
  all: 'すべて',
};

const workspacesOnlySchema = z.object({ workspaces: z.array(structuralWorkspaceSchema) });
type WorkspaceRow = z.infer<typeof structuralWorkspaceSchema>;

type Loaded<T> = { ok: true; value: T } | { ok: false; result: ToolResult };

function failed(text: string): ToolResult {
  return { ok: false, text };
}

function failedLoad(failure: ApiFailure): { ok: false; result: ToolResult } {
  return { ok: false, result: failed(describeFailure(failure)) };
}

function issuesText(error: z.ZodError): string {
  return error.issues
    .map(({ path, message }) => (path.length === 0 ? message : `${path.join('.')}: ${message}`))
    .join(' / ');
}

function json(value: unknown): ToolResult {
  return { ok: true, text: JSON.stringify(value) };
}

/** 31 日以内の期間に区切る（両端を含む。GET /api/occurrences の上限。設計書 5.1）。 */
export function splitPeriod(from: DateStr, to: DateStr): { from: DateStr; to: DateStr }[] {
  const periods: { from: DateStr; to: DateStr }[] = [];
  for (let start = from; start <= to; start = addDays(start, MAX_OCCURRENCES_DAYS)) {
    const end = addDays(start, MAX_OCCURRENCES_DAYS - 1);
    periods.push({ from: start, to: end < to ? end : to });
  }
  return periods;
}

export function createTools({ api, newId, nextEditedAt }: ToolDeps) {
  async function loadWorkspaces(): Promise<Loaded<WorkspaceRow[]>> {
    const result = await callApi(api, 'GET', '/api/changes?since=0');
    if (!result.ok) return failedLoad(result.failure);
    // 構造だけを確かめる（api.ts のコメントのとおり、changesResponseSchema は実行時の確認に使わない）。
    const parsed = workspacesOnlySchema.safeParse(result.body);
    if (!parsed.success) return { ok: false, result: failed('サーバーの応答を読めませんでした') };
    return {
      ok: true,
      value: parsed.data.workspaces.filter(({ deletedAt }) => deletedAt === null),
    };
  }

  async function listWorkspaces(): Promise<ToolResult> {
    const loaded = await loadWorkspaces();
    if (!loaded.ok) return loaded.result;
    return json({
      workspaces: selectableWorkspaces(loaded.value).map(({ id, name, color }) => ({
        id,
        name,
        color,
        colorName: WORKSPACE_COLORS.find((c) => isSameColor(c.value, color))?.name ?? null,
      })),
    });
  }

  async function listEvents({ from, to }: ListEventsInput): Promise<ToolResult> {
    const days = dateToDays(to) - dateToDays(from) + 1;
    if (days > MAX_LIST_DAYS) {
      return failed(
        `期間が長すぎます（${String(days)} 日）。最大 ${String(MAX_LIST_DAYS)} 日までなので、分けて呼んでください`,
      );
    }

    const loaded = await loadWorkspaces();
    if (!loaded.ok) return loaded.result;
    const names = new Map(loaded.value.map(({ id, name }) => [id, name]));

    const seen = new Set<string>();
    const occurrences: (Occurrence & { workspaceName: string | null })[] = [];
    const holidays: { date: string; name: string }[] = [];
    const observances: { date: string; name: string }[] = [];
    // 順番に呼ぶ。並べて呼ぶと、Worker の CPU 時間（無料プランの 1 回 10ms）を同時に使い切るおそれがある。
    for (const period of splitPeriod(from, to)) {
      const result = await callApi(
        api,
        'GET',
        `/api/occurrences?from=${period.from}&to=${period.to}`,
      );
      if (!result.ok) return failed(describeFailure(result.failure));
      const parsed = occurrencesResponseSchema.safeParse(result.body);
      if (!parsed.success) return failed('サーバーの応答を読めませんでした');
      for (const occurrence of parsed.data.occurrences) {
        // 区切りをまたぐ予定は、両方の期間に出る。
        const key = `${occurrence.entryId}\t${occurrence.occurrenceDate}`;
        if (seen.has(key)) continue;
        seen.add(key);
        occurrences.push({
          ...occurrence,
          workspaceName:
            occurrence.workspaceId === null ? null : (names.get(occurrence.workspaceId) ?? null),
        });
      }
      holidays.push(...parsed.data.holidays);
      observances.push(...parsed.data.observances);
    }
    return json({ from, to, occurrences, holidays, observances });
  }

  async function createEvent(input: CreateEventInput): Promise<ToolResult> {
    const allDay = input.allDay ?? false;
    const notifyDefaults = defaultNotify(input.kind, allDay);
    const draft: EntryDraft = {
      kind: input.kind,
      title: input.title,
      workspaceId: input.workspaceId ?? null,
      allDay,
      startDate: input.startDate,
      startTime: input.startTime ?? null,
      endDate: input.endDate,
      endTime: input.endTime ?? null,
      location: input.location ?? null,
      url: input.url ?? null,
      memo: input.memo ?? null,
      rrule: input.rrule ?? null,
      notifyEnabled: input.notifyEnabled ?? notifyDefaults.notifyEnabled,
      notifyOffsetMin: input.notifyOffsetMin ?? notifyDefaults.notifyOffsetMin,
    };
    const problem = entryProblem({ ...draft, untilDate: null });
    if (problem !== null) return failed(`入力が正しくありません: ${problem}`);

    const id = newId();
    const body = putEntryRequestSchema.safeParse({ draft, editedAt: nextEditedAt() });
    if (!body.success) return failed(`入力が正しくありません: ${issuesText(body.error)}`);

    const outcome = await sendWrite(api, 'PUT', `/api/entries/${id}`, body.data);
    const label = draft.kind === 'event' ? '予定' : 'タイムブロック';
    return describeWrite(outcome, `${label}「${draft.title}」を作りました（id: ${id}）`);
  }

  async function updateEvent(input: UpdateEventInput): Promise<ToolResult> {
    if (Object.keys(input.changes).length === 0) {
      return failed('変える項目がありません。changes に、変える項目を書いてください');
    }
    const body = patchEntryRequestSchema.safeParse({
      occurrenceDate: input.occurrenceDate,
      scope: input.scope,
      changes: input.changes,
      newId: newId(),
      editedAt: nextEditedAt(),
    });
    if (!body.success) return failed(`入力が正しくありません: ${issuesText(body.error)}`);

    const outcome = await sendWrite(api, 'PATCH', `/api/entries/${input.seriesId}`, body.data);
    return describeWrite(outcome, `変更しました（範囲: ${SCOPE_LABELS[input.scope]}）`);
  }

  async function deleteEvent(input: DeleteEventInput): Promise<ToolResult> {
    const body = deleteEntryRequestSchema.safeParse({
      occurrenceDate: input.occurrenceDate,
      scope: input.scope,
      newId: newId(),
      editedAt: nextEditedAt(),
    });
    if (!body.success) return failed(`入力が正しくありません: ${issuesText(body.error)}`);

    const outcome = await sendWrite(api, 'DELETE', `/api/entries/${input.seriesId}`, body.data);
    return describeWrite(outcome, `削除しました（範囲: ${SCOPE_LABELS[input.scope]}）`);
  }

  async function createWorkspace(input: CreateWorkspaceInput): Promise<ToolResult> {
    const name = input.name.trim();
    if (name === '') return failed('名前を入れてください');
    const loaded = await loadWorkspaces();
    if (!loaded.ok) return loaded.result;
    const mine = selectableWorkspaces(loaded.value);

    // 色の選び方（firstUnusedColor）と sortOrder は、画面の新しいワークスペース（client/sidebar/workspaceEdit.ts の newWorkspaceInput）と同じ。
    const color =
      input.color === undefined
        ? firstUnusedColor(mine.map((workspace) => workspace.color))
        : (WORKSPACE_COLORS.find((c) => c.name === input.color)?.value ?? null);
    if (color === null) return failed(`その色は選べません: ${String(input.color)}`);

    const id = newId();
    const body = putWorkspaceRequestSchema.safeParse({
      workspace: {
        id,
        name,
        color,
        sortOrder: Math.max(-1, ...mine.map(({ sortOrder }) => sortOrder)) + 1,
        visible: true,
        builtin: null,
        editedAt: nextEditedAt(),
        deletedAt: null,
      },
    });
    if (!body.success) return failed(`入力が正しくありません: ${issuesText(body.error)}`);

    const outcome = await sendWrite(api, 'PUT', `/api/workspaces/${id}`, body.data);
    return describeWrite(outcome, `ワークスペース「${name}」を作りました（id: ${id}）`);
  }

  return { listWorkspaces, listEvents, createEvent, updateEvent, deleteEvent, createWorkspace };
}

export type Tools = ReturnType<typeof createTools>;
