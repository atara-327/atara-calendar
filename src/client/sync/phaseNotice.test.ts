import { describe, expect, it } from 'vitest';
import { PHASE_NOTICE_MESSAGES, phaseNotice } from './phaseNotice';

describe('読み込みの状態の知らせ', () => {
  it('読み込めていて動いているときは、何も出さない', () => {
    expect(phaseNotice('ready', false)).toBeNull();
  });

  it('まだ読み込んでいない（起動中・読み込み中）ときは、読み込み中', () => {
    expect(phaseNotice('idle', false)).toBe('loading');
    expect(phaseNotice('starting', false)).toBe('loading');
    expect(phaseNotice('loading', false)).toBe('loading');
  });

  it('最初の読み込みに失敗したときは、読み込めませんでした', () => {
    expect(phaseNotice('loadFailed', false)).toBe('loadFailed');
  });

  it('別のタブで開いたため止めたときは、止めた理由を出す（読み込みの前でも後でも、状態は同じ）', () => {
    expect(phaseNotice('stopped', true)).toBe('takenOver');
    expect(PHASE_NOTICE_MESSAGES.takenOver).toBe('別のタブで開いたため、このタブは止めました');
  });

  it('文言は、知らせごとに、1 つずつ', () => {
    expect(PHASE_NOTICE_MESSAGES).toEqual({
      takenOver: '別のタブで開いたため、このタブは止めました',
      loadFailed: '読み込めませんでした',
      loading: '読み込み中…',
    });
  });
});
