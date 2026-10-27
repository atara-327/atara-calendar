import { describe, expect, it } from 'vitest';
import { makeEntry } from '../../../test/helpers/entries';
import { makeWorkspace } from '../../../test/helpers/workspaces';
import { INPUT_LIMITS } from '../../shared/schema';
import { WORKSPACE_COLORS, type WorkspaceColor } from '../workspaceColors';
import {
  CURRENT_COLOR_NAME,
  colorSwatches,
  countEntriesIn,
  initialWorkspaceColor,
  isLastWorkspace,
  newWorkspaceInput,
  reorderWorkspaces,
  toWorkspaceInput,
  validateWorkspaceName,
  workspaceToSave,
  type WorkspaceInput,
} from './workspaceEdit';

function paletteColor(name: string): WorkspaceColor {
  const color = WORKSPACE_COLORS.find((candidate) => candidate.name === name);
  if (color === undefined) throw new Error(`8 色に ${name} がありません`);
  return color;
}

const TOMATO = paletteColor('トマト');
const ORANGE = paletteColor('オレンジ');
const BANANA = paletteColor('バナナ');
const BASIL = paletteColor('バジル');

const builtins = [
  makeWorkspace({ id: 'builtin-holiday', builtin: 'holiday', sortOrder: 1_000_000 }),
  makeWorkspace({ id: 'builtin-observance', builtin: 'observance', sortOrder: 1_000_001 }),
];

describe('エンジンに渡す形', () => {
  it('editedAt と deletedAt を除く（エンジンが決める）', () => {
    const input = toWorkspaceInput(
      makeWorkspace({ id: 'w1', name: '仕事', color: '#123456', sortOrder: 3, visible: false }),
    );

    expect(input).toEqual({
      id: 'w1',
      name: '仕事',
      color: '#123456',
      sortOrder: 3,
      visible: false,
      builtin: null,
    });
  });
});

describe('並べ替え（↑ ↓）', () => {
  const a = makeWorkspace({ id: 'a', sortOrder: 0 });
  const b = makeWorkspace({ id: 'b', sortOrder: 1 });
  const c = makeWorkspace({ id: 'c', sortOrder: 2 });

  it('↓ で、1 つ下と入れ替わり、値が変わった行だけが、新しい sortOrder で返る', () => {
    expect(reorderWorkspaces([a, b, c], 'a', 'down')).toEqual([
      { ...b, sortOrder: 0 },
      { ...a, sortOrder: 1 },
    ]);
  });

  it('↑ で、1 つ上と入れ替わる', () => {
    expect(reorderWorkspaces([a, b, c], 'c', 'up')).toEqual([
      { ...c, sortOrder: 1 },
      { ...b, sortOrder: 2 },
    ]);
  });

  it('渡す順序によらず、今の並び（sortOrder の順）で入れ替える', () => {
    expect(reorderWorkspaces([c, a, b], 'b', 'up')).toEqual([
      { ...b, sortOrder: 0 },
      { ...a, sortOrder: 1 },
    ]);
  });

  it('いちばん上の ↑ と、いちばん下の ↓ は、何も変えない', () => {
    expect(reorderWorkspaces([a, b, c], 'a', 'up')).toEqual([]);
    expect(reorderWorkspaces([a, b, c], 'c', 'down')).toEqual([]);
  });

  it('1 つしかないとき、対象がないとき、組み込みの行や削除された行を指すときは、何も変えない', () => {
    const gone = makeWorkspace({ id: 'gone', sortOrder: 5, deletedAt: 9 });

    expect(reorderWorkspaces([a], 'a', 'down')).toEqual([]);
    expect(reorderWorkspaces([a, b], 'unknown', 'down')).toEqual([]);
    expect(reorderWorkspaces([a, b, ...builtins], 'builtin-holiday', 'up')).toEqual([]);
    expect(reorderWorkspaces([a, gone], 'gone', 'up')).toEqual([]);
  });

  it('sortOrder が 0, 1, 2… でないとき（間が空いている）も、並びの順に振り直す', () => {
    const x = makeWorkspace({ id: 'x', sortOrder: 10 });
    const y = makeWorkspace({ id: 'y', sortOrder: 20 });
    const z = makeWorkspace({ id: 'z', sortOrder: 30 });

    expect(reorderWorkspaces([x, y, z], 'z', 'up')).toEqual([
      { ...x, sortOrder: 0 },
      { ...z, sortOrder: 1 },
      { ...y, sortOrder: 2 },
    ]);
  });

  it('同じ sortOrder の行があるとき（API から入れたとき）も、入れ替えた並びになる', () => {
    const p = makeWorkspace({ id: 'p', sortOrder: 0 });
    const q = makeWorkspace({ id: 'q', sortOrder: 0 });

    // 今の並びは p, q（同じ値なら id の順）。q を上げると q, p になるよう、p だけが 1 に動く。
    expect(reorderWorkspaces([p, q], 'q', 'up')).toEqual([{ ...p, sortOrder: 1 }]);
  });

  it('組み込みの行の sortOrder は、変えない（返さない）', () => {
    const changed = reorderWorkspaces([...builtins, a, b], 'b', 'up');

    expect(changed.map(({ id }) => id)).toEqual(['b', 'a']);
  });

  it('元の行を書き換えない', () => {
    const rows = [a, b, c];

    reorderWorkspaces(rows, 'a', 'down');

    expect(rows).toEqual([a, b, c]);
    expect(a.sortOrder).toBe(0);
  });
});

describe('新しいワークスペースの色の初期値', () => {
  const colorOf = (...used: (string | undefined)[]) =>
    used.map((color, index) =>
      makeWorkspace({ id: `w${String(index)}`, ...(color === undefined ? {} : { color }) }),
    );

  it('まだ何も使っていなければ、最初の色（トマト）', () => {
    expect(initialWorkspaceColor([])).toBe(TOMATO.value);
  });

  it('使っている色を飛ばして、使っていない、最初の色にする', () => {
    expect(initialWorkspaceColor(colorOf(TOMATO.value, BANANA.value))).toBe(ORANGE.value);
    expect(initialWorkspaceColor(colorOf(TOMATO.value, ORANGE.value))).toBe(BANANA.value);
  });

  it('8 色の外の色や、16 進の小文字の同じ色も、使っている色として見る', () => {
    const lower = TOMATO.value.toLowerCase();

    expect(initialWorkspaceColor(colorOf('#123456', lower))).toBe(ORANGE.value);
  });

  it('削除されたワークスペースと、組み込みの行の色は、使っているとは見ない', () => {
    const deleted = makeWorkspace({ id: 'gone', color: TOMATO.value, deletedAt: 9 });
    const holiday = makeWorkspace({
      id: 'builtin-holiday',
      builtin: 'holiday',
      color: TOMATO.value,
    });

    expect(initialWorkspaceColor([deleted, holiday])).toBe(TOMATO.value);
  });

  it('8 色を全部使っていれば、最初の色（トマト）', () => {
    const all = WORKSPACE_COLORS.map(({ value }, index) =>
      makeWorkspace({ id: `w${String(index)}`, color: value }),
    );

    expect(initialWorkspaceColor(all)).toBe(TOMATO.value);
  });

  it('使っていない色が飛び飛びでも、最初のものを選ぶ', () => {
    const used = WORKSPACE_COLORS.filter((_, index) => index !== 3).map(({ value }, index) =>
      makeWorkspace({ id: `w${String(index)}`, color: value }),
    );

    expect(initialWorkspaceColor(used)).toBe(BASIL.value);
  });
});

describe('新しく作るワークスペースの入力の初期値', () => {
  it('名前は空、表示は ON、組み込みではなく、sortOrder は、今のいちばん大きい値の次', () => {
    const input = newWorkspaceInput(
      [makeWorkspace({ id: 'a', sortOrder: 0 }), makeWorkspace({ id: 'b', sortOrder: 4 })],
      'new-id',
    );

    expect(input).toMatchObject({
      id: 'new-id',
      name: '',
      sortOrder: 5,
      visible: true,
      builtin: null,
    });
  });

  it('色は、使っていない最初の色', () => {
    const input = newWorkspaceInput([makeWorkspace({ id: 'a', color: TOMATO.value })], 'new-id');

    expect(input.color).toBe(ORANGE.value);
  });

  it('sortOrder は、組み込みの行（大きな値）や削除された行を、基準にしない', () => {
    const gone = makeWorkspace({ id: 'gone', sortOrder: 50, deletedAt: 9 });

    const input = newWorkspaceInput(
      [...builtins, makeWorkspace({ id: 'a', sortOrder: 2 }), gone],
      'n',
    );

    expect(input.sortOrder).toBe(3);
  });

  it('1 つもなければ、sortOrder は 0', () => {
    expect(newWorkspaceInput([], 'n').sortOrder).toBe(0);
  });
});

describe('名前の確認', () => {
  it('空のときは、「名前を入れてください」', () => {
    expect(validateWorkspaceName('')).toBe('名前を入れてください');
  });

  it('空白だけのときも、空と同じ（前後の空白を除いて確かめる）', () => {
    expect(validateWorkspaceName('   ')).toBe('名前を入れてください');
    expect(validateWorkspaceName('　\t')).toBe('名前を入れてください');
  });

  it('上限（50 文字）までは通す。前後の空白は、数えない', () => {
    const limit = INPUT_LIMITS.workspaceName;

    expect(validateWorkspaceName('あ'.repeat(limit))).toBeNull();
    expect(validateWorkspaceName(` ${'あ'.repeat(limit)} `)).toBeNull();
  });

  it('上限を超えたら、上限を添えて、誤りにする', () => {
    const limit = INPUT_LIMITS.workspaceName;

    expect(validateWorkspaceName('あ'.repeat(limit + 1))).toBe('名前は 50 文字までにしてください');
  });

  it('ふつうの名前は、通す', () => {
    expect(validateWorkspaceName('仕事')).toBeNull();
  });
});

describe('既存のワークスペースの保存で送る行（workspaceToSave）', () => {
  const original = makeWorkspace({
    id: 'w1',
    name: '仕事',
    color: '#FF8A65',
    sortOrder: 1,
    visible: true,
  });
  const draftOf = (overrides: Partial<WorkspaceInput> = {}): WorkspaceInput => ({
    ...toWorkspaceInput(original),
    ...overrides,
  });
  const saved = (plan: ReturnType<typeof workspaceToSave>): WorkspaceInput => {
    if (plan.kind !== 'save') throw new Error(`送る行がありません（${plan.kind}）`);
    return plan.workspace;
  };

  it('名前も色も変えなければ、何も送らない', () => {
    expect(workspaceToSave({ original, latest: original, draft: draftOf() })).toEqual({
      kind: 'unchanged',
    });
  });

  it('名前の前後の空白だけを変えたときも、何も送らない', () => {
    const plan = workspaceToSave({
      original,
      latest: original,
      draft: draftOf({ name: ' 仕事  ' }),
    });

    expect(plan).toEqual({ kind: 'unchanged' });
  });

  it('8 色の同じ色（16 進の大文字・小文字だけの違い）を選び直しても、何も送らない', () => {
    const lower = makeWorkspace({ id: 'w1', color: '#ff8a65' });

    const plan = workspaceToSave({
      original: lower,
      latest: lower,
      draft: { ...toWorkspaceInput(lower), color: '#FF8A65' },
    });

    expect(plan).toEqual({ kind: 'unchanged' });
  });

  it('名前だけを変えたら、名前は前後の空白を除いた値になり、色は、保存してある文字列のまま', () => {
    const lower = makeWorkspace({ id: 'w1', color: '#e57373' });

    const plan = workspaceToSave({
      original: lower,
      latest: lower,
      draft: { ...toWorkspaceInput(lower), name: '  趣味 ' },
    });

    expect(saved(plan)).toMatchObject({ name: '趣味', color: '#e57373' });
  });

  it('名前だけを変えたとき、8 色にない色（API から入った値）も、そのまま', () => {
    const legacy = makeWorkspace({ id: 'w1', color: '#12AB34' });

    const plan = workspaceToSave({
      original: legacy,
      latest: legacy,
      draft: { ...toWorkspaceInput(legacy), name: '遊び' },
    });

    expect(saved(plan)).toMatchObject({ name: '遊び', color: '#12AB34' });
  });

  it('色だけを変えたら、色は選んだ値になり、名前は最新の行のまま', () => {
    const latest = { ...original, name: 'ほかの端末で直した名前' };

    const plan = workspaceToSave({ original, latest, draft: draftOf({ color: '#4FC3F7' }) });

    expect(saved(plan)).toMatchObject({ name: 'ほかの端末で直した名前', color: '#4FC3F7' });
  });

  it('開いている間に、ほかの端末が表示と並び順を変えていても、触っていない項目は、最新の行の値になる', () => {
    const latest = { ...original, visible: false, sortOrder: 7 };

    const plan = workspaceToSave({ original, latest, draft: draftOf({ name: '仕事（新）' }) });

    expect(saved(plan)).toEqual({
      id: 'w1',
      name: '仕事（新）',
      color: '#FF8A65',
      sortOrder: 7,
      visible: false,
      builtin: null,
    });
  });

  it('名前も色も、ほかの端末が変えていて、自分は片方だけ変えたなら、変えていない方は、最新の行の値になる', () => {
    const latest = { ...original, name: '別の名前', color: '#7986CB' };

    const plan = workspaceToSave({ original, latest, draft: draftOf({ name: '自分の名前' }) });

    expect(saved(plan)).toMatchObject({ name: '自分の名前', color: '#7986CB' });
  });

  it('開いたときの名前の前後に空白があり（API から入った値）、名前を触らなければ、色だけを変えても、名前は書き換えない', () => {
    const spaced = makeWorkspace({ id: 'w1', name: ' 仕事 ' });

    const plan = workspaceToSave({
      original: spaced,
      latest: spaced,
      draft: { ...toWorkspaceInput(spaced), color: '#4FC3F7' },
    });

    expect(saved(plan)).toMatchObject({ name: ' 仕事 ', color: '#4FC3F7' });
  });

  it('最新の行がない（ほかの端末で削除されて、手元にも残っていない）ときは、何も送らない', () => {
    const plan = workspaceToSave({
      original,
      latest: undefined,
      draft: draftOf({ name: '直した' }),
    });

    expect(plan).toEqual({ kind: 'gone' });
  });

  it('最新の行が、削除済みのときも、何も送らない（サーバーは、削除済みの更新を、黙って捨てる）', () => {
    const latest = { ...original, deletedAt: 5000 };

    const plan = workspaceToSave({ original, latest, draft: draftOf({ name: '直した' }) });

    expect(plan).toEqual({ kind: 'gone' });
  });

  it('何も変えていなくても、最新の行がなければ、「削除された」ことを知らせる（行が一覧から消えた理由が分かるように）', () => {
    expect(workspaceToSave({ original, latest: undefined, draft: draftOf() })).toEqual({
      kind: 'gone',
    });
  });

  it('送る行に、editedAt・deletedAt は含めない（エンジンが決める）', () => {
    const plan = workspaceToSave({
      original,
      latest: original,
      draft: draftOf({ name: '直した' }),
    });

    expect(Object.keys(saved(plan)).sort()).toEqual(
      ['builtin', 'color', 'id', 'name', 'sortOrder', 'visible'].sort(),
    );
  });
});

describe('色の見本', () => {
  it('今の色が 8 色の 1 つなら、8 色だけを出す', () => {
    expect(colorSwatches(BANANA.value)).toEqual(WORKSPACE_COLORS);
  });

  it('今の色が、8 色の同じ色（16 進の小文字）でも、8 色だけを出す', () => {
    expect(colorSwatches(BANANA.value.toLowerCase())).toEqual(WORKSPACE_COLORS);
  });

  it('今の色が 8 色にないなら、9 つ目に「今の色」を足す（その色のまま保存できるように）', () => {
    const swatches = colorSwatches('#123456');

    expect(swatches).toHaveLength(9);
    expect(swatches.slice(0, 8)).toEqual(WORKSPACE_COLORS);
    expect(swatches[8]).toEqual({ name: CURRENT_COLOR_NAME, value: '#123456' });
  });
});

describe('中の予定の件数（削除の確認）', () => {
  it('このワークスペースの、繰り返さない予定を数える', () => {
    const entries = [makeEntry({ id: 'e1' }), makeEntry({ id: 'e2' })];

    expect(countEntriesIn(entries, 'w1')).toBe(2);
  });

  it('繰り返しの系列は、1 件と数える', () => {
    const series = makeEntry({ id: 's1', rrule: { freq: 'daily' } });

    expect(countEntriesIn([series], 'w1')).toBe(1);
  });

  it('例外の行（seriesId がある行）は、数えない', () => {
    const series = makeEntry({ id: 's1', rrule: { freq: 'daily' } });
    const exception = makeEntry({ id: 'x1', seriesId: 's1', originalDate: '2026-10-20' });

    expect(countEntriesIn([series, exception], 'w1')).toBe(1);
  });

  it('削除された行は、数えない', () => {
    expect(countEntriesIn([makeEntry({ id: 'e1', deletedAt: 9 })], 'w1')).toBe(0);
  });

  it('別のワークスペースの予定と、ワークスペースを持たないタイムブロックは、数えない', () => {
    const other = makeEntry({ id: 'e1', workspaceId: 'w2' });
    const block = makeEntry({ id: 'b1', kind: 'block', workspaceId: null });

    expect(countEntriesIn([other, block], 'w1')).toBe(0);
  });

  it('予定がなければ 0', () => {
    expect(countEntriesIn([], 'w1')).toBe(0);
  });
});

describe('最後の 1 つか', () => {
  it('削除されていない、利用者のワークスペースが、この 1 つだけなら、最後の 1 つ', () => {
    expect(isLastWorkspace([makeWorkspace({ id: 'w1' })], 'w1')).toBe(true);
  });

  it('組み込みの行と、削除された行は、数えない', () => {
    const gone = makeWorkspace({ id: 'gone', deletedAt: 9 });

    expect(isLastWorkspace([makeWorkspace({ id: 'w1' }), gone, ...builtins], 'w1')).toBe(true);
  });

  it('表示が OFF のワークスペースも、数える（削除されていないので）', () => {
    const hidden = makeWorkspace({ id: 'hidden', visible: false });

    expect(isLastWorkspace([makeWorkspace({ id: 'w1' }), hidden], 'w1')).toBe(false);
  });

  it('2 つ以上あれば、どれも、最後の 1 つではない', () => {
    const rows = [makeWorkspace({ id: 'w1' }), makeWorkspace({ id: 'w2' })];

    expect(isLastWorkspace(rows, 'w1')).toBe(false);
    expect(isLastWorkspace(rows, 'w2')).toBe(false);
  });

  it('その id が、削除されていない利用者のワークスペースでなければ、最後の 1 つではない', () => {
    expect(isLastWorkspace([makeWorkspace({ id: 'w1' })], 'unknown')).toBe(false);
    expect(isLastWorkspace([], 'w1')).toBe(false);
  });
});
