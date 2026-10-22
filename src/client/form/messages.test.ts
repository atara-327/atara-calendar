import { describe, expect, it } from 'vitest';
import { scopeChangedMessage, scopeUnavailableMessage, unavailableMessage } from './messages';

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

describe('範囲を決められなかったときの理由', () => {
  it('対象の予定が、もうないときは、ほかの端末で変更・削除されたと伝える', () => {
    expect(scopeUnavailableMessage({ kind: 'gone' })).toBe(
      'この予定は、ほかの端末で変更・削除されました',
    );
  });

  it('ルールと日付を同時に変えたときは、片方ずつ保存するよう伝える（実装 #8 の確認 Q3）', () => {
    expect(scopeUnavailableMessage({ kind: 'unavailable', reason: 'ruleAndDate' })).toBe(
      '繰り返しを毎日・平日・休日に変えるときは、日付を同時に変えられません。片方ずつ保存してください',
    );
  });

  it('それ以外の理由で、どの範囲も選べないときは、汎用の文言', () => {
    expect(scopeUnavailableMessage({ kind: 'unavailable', reason: 'other' })).toBe(
      'この組み合わせの変更は保存できません',
    );
  });
});

describe('範囲を選んで送るときに、選んだ範囲がもう選べなかったときの理由', () => {
  it('ほかの端末の変更で選べなくなったことと、範囲を選び直すことを伝える。保存か削除かが入る', () => {
    expect(scopeChangedMessage('保存')).toBe(
      'ほかの端末の変更で、選んだ範囲では保存できなくなりました。もう一度保存して、範囲を選び直してください',
    );
    expect(scopeChangedMessage('削除')).toContain('削除できなくなりました');
  });
});
