import { describe, expect, it } from 'vitest';
import { makeWorkspace } from '../../test/helpers/workspaces';
import { workspaceDisplayOf } from './workspaceDisplay';

const holiday = makeWorkspace({ id: 'builtin-holiday', builtin: 'holiday', color: '#111111' });
const observance = makeWorkspace({
  id: 'builtin-observance',
  builtin: 'observance',
  color: '#222222',
});

describe('ワークスペースから決まる、画面に出すもの', () => {
  it('表示が ON のワークスペースの色だけを持つ（WS-3）。OFF のものと、組み込みの色は持たない', () => {
    const display = workspaceDisplayOf([
      makeWorkspace({ id: 'w1', color: '#AAAAAA' }),
      makeWorkspace({ id: 'w2', color: '#BBBBBB', visible: false }),
      holiday,
      observance,
    ]);

    expect([...display.colors]).toEqual([['w1', '#AAAAAA']]);
  });

  it('削除されたワークスペースは、色を持たず、生きている id にも入らない', () => {
    const display = workspaceDisplayOf([
      makeWorkspace({ id: 'w1' }),
      makeWorkspace({ id: 'w2', deletedAt: 5000 }),
    ]);

    expect(display.colors.has('w2')).toBe(false);
    expect([...display.liveIds]).toEqual(['w1']);
  });

  it('表示が OFF のワークスペースも、削除されていなければ、生きている id に入る（予定は展開してから除くため）', () => {
    const display = workspaceDisplayOf([makeWorkspace({ id: 'w1', visible: false })]);

    expect(display.liveIds.has('w1')).toBe(true);
    expect(display.colors.has('w1')).toBe(false);
  });

  it('組み込みの「祝日」「記念日」が OFF なら、祝日・記念日を出さない。別々に決まる', () => {
    const display = workspaceDisplayOf([
      { ...holiday, visible: false },
      { ...observance, visible: true },
    ]);

    expect(display.showHolidays).toBe(false);
    expect(display.showObservances).toBe(true);
  });

  it('組み込みの行が（まだ読み込んでいなくて）ないときは、祝日・記念日を出す', () => {
    const display = workspaceDisplayOf([]);

    expect(display.showHolidays).toBe(true);
    expect(display.showObservances).toBe(true);
  });
});
