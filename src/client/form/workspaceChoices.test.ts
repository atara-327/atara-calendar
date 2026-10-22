import { describe, expect, it } from 'vitest';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import { defaultWorkspaceId, selectableWorkspaces } from './workspaceChoices';

const work = makeWorkspace({ id: 'work', name: '仕事', sortOrder: 1 });
const hobby = makeWorkspace({ id: 'hobby', name: '趣味', sortOrder: 2 });
const holidays = makeWorkspace({ id: 'builtin-holiday', builtin: 'holiday', sortOrder: 1000 });
const observances = makeWorkspace({
  id: 'builtin-observance',
  builtin: 'observance',
  sortOrder: 1001,
});

describe('予定に選べるワークスペース', () => {
  it('組み込みの「祝日」「記念日」は含めない（予定を入れられない。WS-4）', () => {
    expect(selectableWorkspaces([holidays, work, observances]).map(({ id }) => id)).toEqual([
      'work',
    ]);
  });

  it('削除されたものは含めない', () => {
    const deleted = makeWorkspace({ id: 'old', deletedAt: 5000 });

    expect(selectableWorkspaces([work, deleted]).map(({ id }) => id)).toEqual(['work']);
  });

  it('並び順（sortOrder）で並べる。同じなら id の順', () => {
    const second = makeWorkspace({ id: 'b', sortOrder: 5 });
    const first = makeWorkspace({ id: 'a', sortOrder: 5 });

    expect(selectableWorkspaces([hobby, second, work, first]).map(({ id }) => id)).toEqual([
      'work',
      'hobby',
      'a',
      'b',
    ]);
  });

  it('表示が OFF のワークスペースも含める（OFF でも、予定は入れられる）', () => {
    const hidden = makeWorkspace({ id: 'hidden', visible: false });

    expect(selectableWorkspaces([hidden]).map(({ id }) => id)).toEqual(['hidden']);
  });
});

describe('EV-8: ワークスペースの初期値', () => {
  it('前回、新しく作った予定を保存したワークスペースにする', () => {
    expect(defaultWorkspaceId([work, hobby], 'hobby')).toBe('hobby');
  });

  it('前回のものがなければ（まだ覚えていない）、並び順が最初のワークスペース', () => {
    expect(defaultWorkspaceId([work, hobby], null)).toBe('work');
  });

  it('覚えたワークスペースが削除されていたら（選べなくなっていたら）、並び順が最初のワークスペース', () => {
    expect(defaultWorkspaceId([work, hobby], 'old')).toBe('work');
  });

  it('選べるワークスペースが 1 つもなければ null', () => {
    expect(defaultWorkspaceId([], 'work')).toBeNull();
    expect(defaultWorkspaceId([], null)).toBeNull();
  });
});
