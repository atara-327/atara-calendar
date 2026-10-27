import { describe, expect, it } from 'vitest';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import { menuSections } from './workspaceList';

const holiday = makeWorkspace({
  id: 'builtin-holiday',
  name: '祝日',
  builtin: 'holiday',
  sortOrder: 1_000_000,
});
const observance = makeWorkspace({
  id: 'builtin-observance',
  name: '記念日',
  builtin: 'observance',
  sortOrder: 1_000_001,
});

describe('サイドメニューの節', () => {
  it('利用者のワークスペースは、並び順（sortOrder）で、同じなら id の順に並べる', () => {
    const { workspaces } = menuSections([
      makeWorkspace({ id: 'c', sortOrder: 2 }),
      makeWorkspace({ id: 'b', sortOrder: 1 }),
      makeWorkspace({ id: 'a', sortOrder: 1 }),
    ]);

    expect(workspaces.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
  });

  it('組み込みの行は、利用者のワークスペースに混ぜず、別の節に、祝日・記念日の順で出す', () => {
    const sections = menuSections([observance, makeWorkspace({ id: 'w1' }), holiday]);

    expect(sections.workspaces.map(({ id }) => id)).toEqual(['w1']);
    expect(sections.builtins.map(({ id }) => id)).toEqual([
      'builtin-holiday',
      'builtin-observance',
    ]);
  });

  it('削除されたワークスペースは、どの節にも出さない', () => {
    const sections = menuSections([
      makeWorkspace({ id: 'gone', deletedAt: 5000 }),
      { ...holiday, deletedAt: 5000 },
      observance,
    ]);

    expect(sections.workspaces).toEqual([]);
    expect(sections.builtins.map(({ id }) => id)).toEqual(['builtin-observance']);
  });

  it('表示が OFF のワークスペースも出す（チェックを入れ直せるように）', () => {
    const { workspaces } = menuSections([makeWorkspace({ id: 'hidden', visible: false })]);

    expect(workspaces.map(({ id }) => id)).toEqual(['hidden']);
  });

  it('何も読み込んでいないときは、どちらの節も空', () => {
    expect(menuSections([])).toEqual({ workspaces: [], builtins: [] });
  });
});
