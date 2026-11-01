import { describe, expect, it } from 'vitest';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import { defaultWorkspaceId } from './workspaceChoices';

const work = makeWorkspace({ id: 'work', name: '仕事', sortOrder: 1 });
const hobby = makeWorkspace({ id: 'hobby', name: '趣味', sortOrder: 2 });

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
