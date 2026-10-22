import { describe, expect, it } from 'vitest';
import { unavailableMessage } from './messages';

describe('保存・削除を受け付けられなかったときの理由', () => {
  it('別のタブで開いたため止めているときは、ページを開き直すよう伝える', () => {
    expect(unavailableMessage('stopped', '保存')).toContain('別のタブ');
    expect(unavailableMessage('stopped', '保存')).toContain('開き直して');
  });

  it('読み込みが終わっていないとき（読み込み中・読み込めなかった）は、読み込みが終わっていないことを伝える', () => {
    for (const phase of ['starting', 'loading', 'loadFailed'] as const) {
      expect(unavailableMessage(phase, '保存')).toContain('読み込みが終わっていない');
    }
  });

  it('保存か削除かが、文言に入る', () => {
    expect(unavailableMessage('loading', '保存')).toContain('保存できませんでした');
    expect(unavailableMessage('loading', '削除')).toContain('削除できませんでした');
  });
});
