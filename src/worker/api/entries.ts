import { Hono } from 'hono';
import {
  deleteEntryRequestSchema,
  patchEntryRequestSchema,
  putEntryRequestSchema,
} from '../../shared/api';
import {
  OccurrenceNotFoundError,
  changeEntry,
  createEntry,
  deleteEntry,
} from '../../shared/recurrence';
import type { Entry } from '../../shared/schema';
import { readSeriesEntries } from '../db/store';
import type { AppEnv } from '../env';
import { badRequest } from './errors';
import { assertEditedAtNotInFuture, parseBody, parseId } from './request';
import { commitEntries, dropped } from './write';

/**
 * 書く行の計算。日付の計算が、対応する年の範囲（1900〜2199 年）を出たときの RangeError は、依頼の値が原因で、
 * 再送しても直らないので 400 にする（例: 2199-12-31 から始まる「平日」の繰り返しは、開始日を 2200 年へずらす
 * 途中で、祝日の計算が対応外の年で例外を投げる）。500 にすると、端末が再送し続けるため。
 */
function calculate<T>(compute: () => T): T {
  try {
    return compute();
  } catch (error) {
    if (error instanceof RangeError) throw badRequest(`日付の計算ができません: ${error.message}`);
    throw error;
  }
}

/** 変更・削除の計算。対象がもうないとき（OccurrenceNotFoundError）は null。 */
function calculateOrNull(compute: () => Entry[]): Entry[] | null {
  try {
    return calculate(compute);
  } catch (error) {
    if (error instanceof OccurrenceNotFoundError) return null;
    throw error;
  }
}

export const entriesRoute = new Hono<AppEnv>();

entriesRoute.put('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  const { draft, editedAt } = await parseBody(c, putEntryRequestSchema);
  assertEditedAtNotInFuture(editedAt);

  // 同じ id の行がすでにあっても、上書きしない（PUT は作成だけで、別の行を壊さないため。write.ts の checkNewId）。
  const rows = calculate(() => createEntry({ draft, newId: id, editedAt }));
  return c.json(await commitEntries(c.env.DB, rows, editedAt, { newId: id, loaded: [] }));
});

entriesRoute.patch('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  const { occurrenceDate, scope, changes, newId, editedAt } = await parseBody(
    c,
    patchEntryRequestSchema,
  );
  assertEditedAtNotInFuture(editedAt);
  // 新しい行の id が系列の id と同じだと、「この予定のみ」の例外の行が、系列の行を上書きしてしまう。
  if (newId === id) throw badRequest('newId が、系列の id と同じです');

  const db = c.env.DB;
  const entries = (await readSeriesEntries(db, id)).map(({ entry }) => entry);
  const rows = calculateOrNull(() =>
    changeEntry({
      entries,
      target: { seriesId: id, occurrenceDate },
      scope,
      changes,
      newId,
      editedAt,
    }),
  );
  if (rows === null)
    return c.json(
      dropped(
        entries.find((entry) => entry.id === id),
        editedAt,
      ),
    );
  return c.json(await commitEntries(db, rows, editedAt, { newId, loaded: entries }));
});

entriesRoute.delete('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  const { occurrenceDate, scope, newId, editedAt } = await parseBody(c, deleteEntryRequestSchema);
  assertEditedAtNotInFuture(editedAt);
  if (newId === id) throw badRequest('newId が、系列の id と同じです');

  const db = c.env.DB;
  const entries = (await readSeriesEntries(db, id)).map(({ entry }) => entry);
  const rows = calculateOrNull(() =>
    deleteEntry({ entries, target: { seriesId: id, occurrenceDate }, scope, newId, editedAt }),
  );
  if (rows === null)
    return c.json(
      dropped(
        entries.find((entry) => entry.id === id),
        editedAt,
      ),
    );
  return c.json(await commitEntries(db, rows, editedAt, { newId, loaded: entries }));
});
