import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../test/helpers/entries';
import { makeWorkspace } from '../../test/helpers/workspaces';
import {
  apiErrorBodySchema,
  apiErrorKindSchema,
  changesResponseSchema,
  occurrencesResponseSchema,
  writeResponseSchema,
} from './api';

describe('writeResponseSchema（設計書 5.1 の、書き込みの応答）', () => {
  it.each([
    { applied: true },
    { applied: false, reason: 'stale' },
    { applied: false, reason: 'not_found' },
  ])('%j を通す', (body) => {
    expect(writeResponseSchema.parse(body)).toEqual(body);
  });

  it.each([
    { name: '捨てたのに reason がない', body: { applied: false } },
    { name: '知らない reason', body: { applied: false, reason: 'unknown' } },
    { name: 'applied がない', body: { reason: 'stale' } },
    { name: 'applied が真偽値でない', body: { applied: 'true' } },
  ])('$name は通さない', ({ body }) => {
    expect(writeResponseSchema.safeParse(body).success).toBe(false);
  });

  it('applied: true の応答に、rev が付いていても読める（rev は読まずに捨てる）', () => {
    expect(writeResponseSchema.parse({ applied: true, rev: 5 })).toEqual({ applied: true });
  });
});

describe('changesResponseSchema（GET /api/changes の応答）', () => {
  const body = {
    rev: 3,
    epoch: 'abcd',
    workspaces: [makeWorkspace({ id: 'w1' })],
    entries: [makeEntry({ id: 'e1' })],
  };

  it('rev・epoch・ワークスペース・予定の組を通す', () => {
    expect(changesResponseSchema.parse(body)).toEqual(body);
  });

  it.each([
    { name: 'rev がない', change: { rev: undefined } },
    { name: 'rev が整数でない', change: { rev: 1.5 } },
    { name: 'epoch がない', change: { epoch: undefined } },
    { name: '予定の行が壊れている', change: { entries: [{ id: 'e1' }] } },
  ])('$name は通さない', ({ change }) => {
    expect(changesResponseSchema.safeParse({ ...body, ...change }).success).toBe(false);
  });
});

describe('occurrencesResponseSchema（GET /api/occurrences の応答）', () => {
  const occurrence = {
    kind: 'event',
    title: 'ジム',
    workspaceId: 'w1',
    allDay: true,
    startDate: '2026-10-19',
    startTime: null,
    endDate: '2026-10-19',
    endTime: null,
    location: null,
    url: null,
    memo: null,
    notifyEnabled: true,
    notifyOffsetMin: 10,
    entryId: 'e1',
    seriesId: 'e1',
    occurrenceDate: '2026-10-19',
    isException: false,
    recurring: false,
  };

  it('回・祝日・記念日を通す', () => {
    const body = {
      occurrences: [occurrence],
      holidays: [{ date: '2026-11-03', name: '文化の日' }],
      observances: [{ date: '2026-10-31', name: 'ハロウィン' }],
    };

    expect(occurrencesResponseSchema.parse(body)).toEqual(body);
  });

  it('空の応答を通す', () => {
    const body = { occurrences: [], holidays: [], observances: [] };

    expect(occurrencesResponseSchema.parse(body)).toEqual(body);
  });

  it.each([
    { name: '回に entryId がない', body: { occurrences: [{ ...occurrence, entryId: undefined }] } },
    {
      name: '祝日の日付が不正',
      body: { holidays: [{ date: '2026-02-30', name: '存在しない日' }] },
    },
    { name: '祝日に名前がない', body: { holidays: [{ date: '2026-11-03' }] } },
  ])('$name は通さない', ({ body }) => {
    const base = { occurrences: [], holidays: [], observances: [] };

    expect(occurrencesResponseSchema.safeParse({ ...base, ...body }).success).toBe(false);
  });
});

describe('apiErrorBodySchema（エラーの本文）', () => {
  it.each(apiErrorKindSchema.options)('種類 %s を通す', (error) => {
    expect(apiErrorBodySchema.parse({ error, message: '固定の文言' })).toEqual({
      error,
      message: '固定の文言',
    });
  });

  it('API が返す 404 の種類（not_found）を含む', () => {
    expect(apiErrorKindSchema.options).toContain('not_found');
  });

  it.each([
    { name: '知らない種類', body: { error: 'forbidden', message: 'x' } },
    { name: 'message がない', body: { error: 'conflict' } },
  ])('$name は通さない', ({ body }) => {
    expect(apiErrorBodySchema.safeParse(body).success).toBe(false);
  });
});
