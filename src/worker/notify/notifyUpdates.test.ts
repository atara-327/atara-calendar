import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../../shared/schema';
import { makeEntry } from '../../../test/helpers/entries';
import { jst } from '../../../test/helpers/time';
import type { StoredEntry } from '../db/rows';
import { planNotifyUpdates } from './notifyUpdates';

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = jst('2026-10-27', '09:00');

/** 時間指定の予定（15:00〜16:00、10 分前に通知）。 */
function timed(overrides: Partial<Entry> & Pick<Entry, 'id'>): Entry {
  return makeEntry({
    allDay: false,
    startDate: '2026-10-27',
    startTime: '15:00',
    endTime: '16:00',
    notifyOffsetMin: 10,
    ...overrides,
  });
}

function stored(entry: Entry, nextNotifyAt: number | null = null): StoredEntry {
  return { entry, rev: 1, nextNotifyAt };
}

const daily = () => timed({ id: 's', rrule: { freq: 'daily' }, startDate: '2026-10-19' });
const exception = (overrides: Partial<Entry> & Pick<Entry, 'id' | 'originalDate'>) =>
  timed({ seriesId: 's', ...overrides });

describe('planNotifyUpdates（保存したときの、next_notify_at の更新を決める）', () => {
  it('書いた行は、upsert が NULL に戻しているので、計算した値が NULL でなければ、更新に入る', () => {
    const updates = planNotifyUpdates({
      stored: [],
      written: [timed({ id: 'a', editedAt: 1000 })],
      nowMs: NOW,
    });

    expect(updates).toEqual([
      { id: 'a', editedAt: 1000, nextNotifyAt: jst('2026-10-27', '14:50') },
    ]);
  });

  it('書いた行の計算した値が NULL なら、更新に入れない（upsert が戻した NULL のままでよい）', () => {
    const updates = planNotifyUpdates({
      stored: [stored(timed({ id: 'a' }), jst('2026-10-27', '14:50'))],
      written: [timed({ id: 'a', editedAt: 2000, notifyEnabled: false })],
      nowMs: NOW,
    });

    expect(updates).toEqual([]);
  });

  it('書かない行は、今の値と違うときだけ、更新に入る。更新には、読んだときの editedAt を付ける', () => {
    const series = daily();
    const updates = planNotifyUpdates({
      stored: [stored({ ...series, editedAt: 777 }, jst('2026-10-27', '14:50'))],
      written: [exception({ id: 'x', originalDate: '2026-10-27', startDate: '2026-10-29' })],
      nowMs: NOW,
    });

    expect(updates).toEqual([
      { id: 's', editedAt: 777, nextNotifyAt: jst('2026-10-28', '14:50') },
      { id: 'x', editedAt: 1000, nextNotifyAt: jst('2026-10-29', '14:50') },
    ]);
  });

  it('書かない行の値が、計算し直しても同じなら、更新に入れない', () => {
    const updates = planNotifyUpdates({
      stored: [stored(daily(), jst('2026-10-27', '14:50'))],
      written: [exception({ id: 'x', originalDate: '2026-10-30', startDate: '2026-10-31' })],
      nowMs: NOW,
    });

    expect(updates.map(({ id }) => id)).toEqual(['x']);
  });

  it('書く行と同じ id の今の行は、書く行で置き換えて計算する', () => {
    const updates = planNotifyUpdates({
      stored: [stored(timed({ id: 'a', startTime: '15:00' }), jst('2026-10-27', '14:50'))],
      written: [timed({ id: 'a', editedAt: 2000, startTime: '17:00' })],
      nowMs: NOW,
    });

    expect(updates).toEqual([
      { id: 'a', editedAt: 2000, nextNotifyAt: jst('2026-10-27', '16:50') },
    ]);
  });

  it('削除する行は、更新に入れない。書く行がすべて削除の系列は、今の行を見ない', () => {
    const updates = planNotifyUpdates({
      stored: [stored(daily(), jst('2026-10-27', '14:50'))],
      written: [{ ...daily(), editedAt: 2000, deletedAt: 2000 }],
      nowMs: NOW,
    });

    expect(updates).toEqual([]);
  });

  it('書く行の系列と別の系列の今の行は、見ない', () => {
    const other = timed({ id: 'other', startDate: '2026-10-28' });

    const updates = planNotifyUpdates({
      stored: [stored(other, null)],
      written: [timed({ id: 'a' })],
      nowMs: NOW,
    });

    expect(updates.map(({ id }) => id)).toEqual(['a']);
  });

  describe('時刻が来て、まだ送っていない通知（書かない行は、飛ばさない）', () => {
    // 14:50 に通知する毎日の系列。14:50:20 になっても、定期実行がまだ拾っていない（next_notify_at は今日の 14:50 のまま）。
    const due = jst('2026-10-27', '14:50');
    const afterDue = due + 20_000;

    it('明日の回を「この予定のみ」で変えても、書かない系列の行は、今日の通知のまま（更新に入れない）', () => {
      const updates = planNotifyUpdates({
        stored: [stored(daily(), due)],
        written: [exception({ id: 'x', originalDate: '2026-10-28', startDate: '2026-10-28' })],
        nowMs: afterDue,
      });

      expect(updates).toEqual([
        { id: 'x', editedAt: 1000, nextNotifyAt: jst('2026-10-28', '14:50') },
      ]);
    });

    it('書く行は、これまでどおり「今」で計算する（保存した時点で過ぎている回は飛ばす）', () => {
      const updates = planNotifyUpdates({
        stored: [stored(daily(), due)],
        written: [{ ...daily(), editedAt: 2000, title: '名前を変える' }],
        nowMs: afterDue,
      });

      expect(updates).toEqual([
        { id: 's', editedAt: 2000, nextNotifyAt: jst('2026-10-28', '14:50') },
      ]);
    });

    it('時刻が来た回を、例外で別の日に移したときは、書かない系列の行は、その回を飛ばして次の回になる', () => {
      const updates = planNotifyUpdates({
        stored: [stored(daily(), due)],
        written: [
          exception({
            id: 'x',
            originalDate: '2026-10-27',
            startDate: '2026-10-28',
            startTime: '10:00',
          }),
        ],
        nowMs: afterDue,
      });

      expect(updates).toEqual([
        { id: 's', editedAt: 1000, nextNotifyAt: jst('2026-10-28', '14:50') },
        { id: 'x', editedAt: 1000, nextNotifyAt: jst('2026-10-28', '09:50') },
      ]);
    });

    it('書かない行の今の値が、まだ先（今より後）なら、「今」で計算する（これまでどおり）', () => {
      const updates = planNotifyUpdates({
        stored: [stored(daily(), jst('2026-10-27', '14:50'))],
        written: [exception({ id: 'x', originalDate: '2026-10-27', startDate: '2026-10-29' })],
        nowMs: jst('2026-10-27', '09:00'),
      });

      expect(updates.find(({ id }) => id === 's')).toEqual({
        id: 's',
        editedAt: 1000,
        nextNotifyAt: jst('2026-10-28', '14:50'),
      });
    });

    it('書かない行の今の値が NULL なら、「今」で計算する（過ぎた回は飛ばす）', () => {
      const updates = planNotifyUpdates({
        stored: [stored(daily(), null)],
        written: [exception({ id: 'x', originalDate: '2026-10-29', startDate: '2026-10-29' })],
        nowMs: afterDue,
      });

      expect(updates.find(({ id }) => id === 's')).toEqual({
        id: 's',
        editedAt: 1000,
        nextNotifyAt: jst('2026-10-28', '14:50'),
      });
    });
  });

  describe('計算が例外を投げたとき', () => {
    // 存在しない日付（2/30）の行は、通知の時刻を求めるところで RangeError になる。entrySchema を通らない行だが、
    // この関数は、書く行を確かめない（確かめるのは applyWrite）ので、計算が例外を投げる場合を、データで再現できる。
    const broken = () => timed({ id: 'broken', startDate: '2026-02-30', endDate: '2026-02-30' });

    it('その系列の、削除されていない全行を NULL にする。書かない行の古い値は、NULL への更新になる', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const sibling = exception({ id: 'x', originalDate: '2026-10-28', startDate: '2026-10-28' });

      const updates = planNotifyUpdates({
        stored: [
          stored(daily(), jst('2026-10-27', '14:50')),
          stored(sibling, jst('2026-10-28', '14:50')),
        ],
        written: [{ ...broken(), id: 'y', seriesId: 's', originalDate: '2026-10-29' }],
        nowMs: NOW,
      });

      expect(updates).toEqual([
        { id: 's', editedAt: 1000, nextNotifyAt: null },
        { id: 'x', editedAt: 1000, nextNotifyAt: null },
      ]);
    });

    it('ほかの系列の計算は続け、ログに、系列の id と例外を出す', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const updates = planNotifyUpdates({
        stored: [],
        written: [broken(), timed({ id: 'ok' })],
        nowMs: NOW,
      });

      expect(updates).toEqual([
        { id: 'ok', editedAt: 1000, nextNotifyAt: jst('2026-10-27', '14:50') },
      ]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[0]).toContain('id: broken');
      expect(error.mock.calls[0]?.[1]).toBeInstanceOf(RangeError);
    });
  });
});
