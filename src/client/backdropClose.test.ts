import { describe, expect, it } from 'vitest';
import { createBackdropPress } from './backdropClose';

describe('背景を押して閉じる判定', () => {
  it('背景で押し始めて、背景で離したら、閉じる', () => {
    const press = createBackdropPress();

    press.start(true);

    expect(press.end(true)).toBe(true);
  });

  it('中身で押し始めて、背景で離したら、閉じない（入力欄で文字を選ぶ途中に、背景へはみ出したとき）', () => {
    const press = createBackdropPress();

    press.start(false);

    expect(press.end(true)).toBe(false);
  });

  it('中身で押して、中身で離したら、閉じない', () => {
    const press = createBackdropPress();

    press.start(false);

    expect(press.end(false)).toBe(false);
  });

  it('続けて押した 2 回目の click（開くボタンのダブルクリックで、開いた直後の背景に当たったとき）は、閉じない', () => {
    const press = createBackdropPress();

    press.start(true);

    expect(press.end(true, 2)).toBe(false);
  });

  it('押し始めを見ていない click（キーボードで押したボタンなど）は、閉じない', () => {
    const press = createBackdropPress();

    expect(press.end(true)).toBe(false);
  });

  it('閉じると決めたあとは、押し始めの位置を忘れる（続けて届いた click で、また閉じない）', () => {
    const press = createBackdropPress();
    press.start(true);
    press.end(true);

    expect(press.end(true)).toBe(false);
  });

  it('中身で押し始めて閉じなかったあとも、押し始めの位置を忘れる', () => {
    const press = createBackdropPress();
    press.start(false);
    press.end(true);

    expect(press.end(true)).toBe(false);
  });

  it('押し始めの位置は、いちばん新しい 1 回だけを使う', () => {
    const press = createBackdropPress();
    press.start(true);
    press.start(false);

    expect(press.end(true)).toBe(false);
  });
});
