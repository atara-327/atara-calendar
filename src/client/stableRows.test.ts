import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../test/helpers/entries';
import { makeWorkspace } from '../../test/helpers/workspaces';
import { createViewSelector } from './stableRows';
import type { RowSet } from './sync/replay';
import { initialState, type SyncState } from './sync/state';

function stateOf(view: RowSet): SyncState {
  return { ...initialState(), view };
}

const w1 = makeWorkspace({ id: 'w1' });
const e1 = makeEntry({ id: 'e1' });
const e2 = makeEntry({ id: 'e2' });

function rows(entries = [e1], workspaces = [w1]): RowSet {
  return {
    workspaces: new Map(workspaces.map((row) => [row.id, row])),
    entries: new Map(entries.map((row) => [row.id, row])),
  };
}

describe('画面に出すデータ（view）を読む selector', () => {
  it('最初の呼び出しは、view をそのまま返す', () => {
    const view = rows();
    expect(createViewSelector()(stateOf(view))).toBe(view);
  });

  it('参照だけが新しくて、行が全部同じなら、前と同じ参照を返す（受け取りのたびに、計算し直さないため）', () => {
    const select = createViewSelector();
    const first = select(stateOf(rows()));

    const second = select(stateOf(rows()));

    expect(second).toBe(first);
  });

  it('行が増えたら、新しい参照を返す', () => {
    const select = createViewSelector();
    const first = select(stateOf(rows([e1])));

    const second = select(stateOf(rows([e1, e2])));

    expect(second).not.toBe(first);
    expect(second.entries.size).toBe(2);
  });

  it('行が減ったら、新しい参照を返す', () => {
    const select = createViewSelector();
    select(stateOf(rows([e1, e2])));

    expect(select(stateOf(rows([e1]))).entries.size).toBe(1);
  });

  it('同じ id の行が、別の行（編集された行）に変わったら、新しい参照を返す', () => {
    const select = createViewSelector();
    const first = select(stateOf(rows([e1])));

    const second = select(stateOf(rows([{ ...e1, title: '変えた' }])));

    expect(second).not.toBe(first);
    expect(second.entries.get('e1')?.title).toBe('変えた');
  });

  it('ワークスペースの行が変わったとき（表示の ON/OFF など）も、新しい参照を返す', () => {
    const select = createViewSelector();
    const first = select(stateOf(rows([e1], [w1])));

    const second = select(stateOf(rows([e1], [{ ...w1, visible: false }])));

    expect(second).not.toBe(first);
  });

  it('selector ごとに覚えるので、別の selector には影響しない', () => {
    const view = rows();
    const a = createViewSelector();
    const b = createViewSelector();
    a(stateOf(view));

    expect(b(stateOf(rows()))).not.toBe(view);
  });
});
