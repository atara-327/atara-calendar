import { describe, expect, it } from 'vitest';
import { dayPath, parseRoute } from './route';

describe('URL から画面を決める', () => {
  it('/ は月表示', () => {
    expect(parseRoute('/')).toEqual({ name: 'month' });
  });

  it('/day/YYYY-MM-DD は、その日の日表示', () => {
    expect(parseRoute('/day/2026-10-21')).toEqual({ name: 'day', date: '2026-10-21' });
  });

  it('スクロールできる範囲の両端（1900-01-01 と 2199-12-31）の日表示を開ける', () => {
    expect(parseRoute('/day/1900-01-01')).toEqual({ name: 'day', date: '1900-01-01' });
    expect(parseRoute('/day/2199-12-31')).toEqual({ name: 'day', date: '2199-12-31' });
  });

  it('範囲の外の日付は不正（呼び出し側が / に戻す）', () => {
    expect(parseRoute('/day/1899-12-31')).toBeNull();
    expect(parseRoute('/day/2200-01-01')).toBeNull();
    expect(parseRoute('/day/0001-01-01')).toBeNull();
  });

  it.each(['/day/2026-02-30', '/day/2026-13-01', '/day/2026-00-10', '/day/2026-10-00'])(
    '存在しない日付 %s は不正',
    (path) => {
      expect(parseRoute(path)).toBeNull();
    },
  );

  it.each([
    '/day',
    '/day/',
    '/day/2026-10-21/',
    '/day/2026-1-21',
    '/day/20261021',
    '/day/abcd-ef-gh',
    '/day/2026-10-21/extra',
    '/month',
    '/foo',
    '',
  ])('形が正しくない %s は不正', (path) => {
    expect(parseRoute(path)).toBeNull();
  });
});

describe('画面から URL を作る', () => {
  it('日表示の URL は /day/YYYY-MM-DD', () => {
    expect(dayPath('2026-10-21')).toBe('/day/2026-10-21');
  });

  it('作った URL は、読み戻せる', () => {
    expect(parseRoute(dayPath('2026-10-21'))).toEqual({ name: 'day', date: '2026-10-21' });
  });
});
