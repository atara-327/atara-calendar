import { describe, expect, it } from 'vitest';
import { dayPath } from './paths';

describe('画面の URL のパス', () => {
  it('日表示のパスは /day/YYYY-MM-DD', () => {
    expect(dayPath('2026-10-21')).toBe('/day/2026-10-21');
  });
});
