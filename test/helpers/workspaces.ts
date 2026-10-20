import type { Workspace } from '../../src/shared/schema';

/** テスト用のワークスペースの行。id 以外を省くと、表示 ON の、組み込みでない行になる。 */
export function makeWorkspace(overrides: Partial<Workspace> & Pick<Workspace, 'id'>): Workspace {
  return {
    name: '仕事',
    color: '#4285F4',
    sortOrder: 0,
    visible: true,
    builtin: null,
    editedAt: 1000,
    deletedAt: null,
    ...overrides,
  };
}
