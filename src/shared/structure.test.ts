import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../test/helpers/entries';
import { makeWorkspace } from '../../test/helpers/workspaces';
import { changesResponseSchema, type ChangesResponse } from './api';
import { entrySchema, workspaceSchema } from './schema';
import {
  structuralChangesResponseSchema,
  structuralEntrySchema,
  structuralWorkspaceSchema,
} from './structure';

const body: ChangesResponse = {
  rev: 3,
  epoch: 'abcd',
  workspaces: [makeWorkspace({ id: 'w1' })],
  entries: [makeEntry({ id: 'e1' })],
};

describe('structuralChangesResponseSchema（受け取りの応答の、構造だけの確認）', () => {
  it('サーバーが返す応答（changesResponseSchema を満たすもの）を、そのまま通す', () => {
    expect(structuralChangesResponseSchema.parse(body)).toEqual(body);
  });

  it('導かれる型は、changesResponseSchema の型と同じ（画面が、応答を同じ型として扱える）', () => {
    const parsed: ChangesResponse = structuralChangesResponseSchema.parse(body);
    expect(changesResponseSchema.parse(parsed)).toEqual(body);
  });

  it('知らない項目があっても読める（読んだ後は捨てる）。サーバーが項目を足しても、古い画面が止まらない', () => {
    const withExtra = {
      ...body,
      added: 1,
      entries: [{ ...makeEntry({ id: 'e1' }), nextNotifyAt: 5, rev: 9 }],
    };
    expect(structuralChangesResponseSchema.parse(withExtra)).toEqual(body);
  });

  it.each([
    { name: 'rev がない', change: { rev: undefined } },
    { name: 'rev が整数でない', change: { rev: 1.5 } },
    { name: 'epoch がない', change: { epoch: undefined } },
    { name: 'workspaces が配列でない', change: { workspaces: {} } },
    { name: 'entries がない', change: { entries: undefined } },
  ])('$name 応答は通さない', ({ change }) => {
    expect(structuralChangesResponseSchema.safeParse({ ...body, ...change }).success).toBe(false);
  });
});

describe('structuralEntrySchema（予定の行の構造）', () => {
  it.each([
    { name: 'id が空', change: { id: '' } },
    { name: 'kind が知らない値', change: { kind: 'todo' } },
    { name: 'title が文字列でない', change: { title: 1 } },
    { name: '日付の形が違う', change: { startDate: '2026/10/19' } },
    { name: '存在しない日付', change: { startDate: '2026-02-30' } },
    { name: '時刻の形が違う', change: { startTime: '9:00' } },
    { name: '24 時台の時刻', change: { startTime: '24:00' } },
    { name: 'allDay が真偽値でない', change: { allDay: 1 } },
    { name: 'rrule の形が違う', change: { rrule: { freq: 'hourly' } } },
    { name: 'editedAt が整数でない', change: { editedAt: 1.5 } },
    { name: '必須の項目がない', change: { cancelled: undefined } },
  ])('$name 行は通さない', ({ change }) => {
    const row = { ...makeEntry({ id: 'e1' }), ...change };
    expect(structuralEntrySchema.safeParse(row).success).toBe(false);
  });

  // 入力のルールは、読み込みでは確かめない（設計書 6.3）。ルールを後で厳しくしても、すでにある行で、
  // 全端末の受け取りが止まらないようにするため。書き込み用のスキーマが弾く行でも、構造としては読める。
  it.each([
    {
      name: '15 分刻みでない時刻',
      change: { startTime: '09:07', endTime: '10:07', allDay: false },
    },
    { name: '長いタイトル', change: { title: 'あ'.repeat(5000) } },
    { name: '範囲外の年', change: { startDate: '1850-01-01', endDate: '1850-01-01' } },
    { name: 'http で始まらない URL', change: { url: 'javascript:alert(1)' } },
  ])('$name の行は、構造としては通す（入力のルールは見ない）', ({ change }) => {
    const row = { ...makeEntry({ id: 'e1' }), ...change };
    expect(structuralEntrySchema.safeParse(row).success).toBe(true);
  });

  it('入力のルールを含む書き込み用のスキーマが弾く行を、構造だけのスキーマは通す（15 分刻み）', () => {
    const row = { ...makeEntry({ id: 'e1' }), allDay: false, startTime: '09:07', endTime: '10:07' };
    expect(entrySchema.safeParse(row).success).toBe(false);
    expect(structuralEntrySchema.safeParse(row).success).toBe(true);
  });
});

describe('structuralWorkspaceSchema（ワークスペースの行の構造）', () => {
  it.each([
    { name: 'id が空', change: { id: '' } },
    { name: 'name がない', change: { name: undefined } },
    { name: 'sortOrder が整数でない', change: { sortOrder: 0.5 } },
    { name: 'visible が真偽値でない', change: { visible: 'yes' } },
    { name: 'builtin が知らない値', change: { builtin: 'custom' } },
    { name: 'deletedAt が整数でない', change: { deletedAt: 'now' } },
  ])('$name 行は通さない', ({ change }) => {
    const row = { ...makeWorkspace({ id: 'w1' }), ...change };
    expect(structuralWorkspaceSchema.safeParse(row).success).toBe(false);
  });

  it('#RRGGBB でない色の行は、構造としては通す（入力のルールは見ない）', () => {
    const row = { ...makeWorkspace({ id: 'w1' }), color: 'red' };
    expect(workspaceSchema.safeParse(row).success).toBe(false);
    expect(structuralWorkspaceSchema.safeParse(row).success).toBe(true);
  });
});
