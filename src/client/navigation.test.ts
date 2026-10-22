import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goToMonth, navigate, replaceDay } from './navigation';

/**
 * window の、history と location の偽物。navigation.ts が使う範囲だけ。
 * back は、動いた回数を数えるだけで、履歴は動かさない（実際のブラウザの back は非同期）。
 */
class FakeWindow {
  readonly entries: { state: unknown; path: string }[] = [{ state: null, path: '/' }];
  index = 0;
  backCalls = 0;

  readonly location = {
    get pathname(): string {
      return fake.entries[fake.index]?.path ?? '/';
    },
  };

  readonly history = {
    get state(): unknown {
      return fake.entries[fake.index]?.state;
    },
    pushState: (state: unknown, _unused: string, path: string): void => {
      this.entries.splice(this.index + 1);
      this.entries.push({ state, path });
      this.index += 1;
    },
    replaceState: (state: unknown, _unused: string, path: string): void => {
      this.entries[this.index] = { state, path };
    },
    back: (): void => {
      this.backCalls += 1;
    },
  };

  addEventListener(): void {
    // popstate は使わない。
  }

  removeEventListener(): void {
    // popstate は使わない。
  }
}

let fake: FakeWindow;

beforeEach(() => {
  fake = new FakeWindow();
  vi.stubGlobal('window', fake);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('日表示で別の日へ移る（replaceDay）', () => {
  it('履歴を積まず、今の履歴の URL だけを、その日に置き換える', () => {
    navigate('/day/2026-10-19');
    expect(fake.entries).toHaveLength(2);

    replaceDay('2026-10-20');

    expect(fake.entries).toHaveLength(2);
    expect(fake.location.pathname).toBe('/day/2026-10-20');
  });

  it('履歴の印（この画面が積んだ履歴）を保つ', () => {
    navigate('/day/2026-10-19');
    const before = fake.history.state;

    replaceDay('2026-10-20');

    expect(fake.history.state).toBe(before);
  });

  it('今の日と同じなら、何もしない', () => {
    navigate('/day/2026-10-19');
    const replaceState = vi.spyOn(fake.history, 'replaceState');

    replaceDay('2026-10-19');

    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe('月表示へ戻る（goToMonth）', () => {
  it('月表示から日表示へ移り、何日動いたあとでも、履歴を 1 つ戻す（前の日に戻らない）', () => {
    navigate('/day/2026-10-19');
    replaceDay('2026-10-20');
    replaceDay('2026-10-21');
    replaceDay('2026-10-18');

    goToMonth();

    expect(fake.backCalls).toBe(1);
    expect(fake.entries).toHaveLength(2);
  });

  it('アドレスを直接開いた日表示（この画面が積んだ履歴ではない）では、月表示へ移る。何日動いたあとでも同じ', () => {
    fake.entries[0] = { state: null, path: '/day/2026-10-19' };
    replaceDay('2026-10-20');

    goToMonth();

    expect(fake.backCalls).toBe(0);
    expect(fake.location.pathname).toBe('/');
    expect(fake.entries).toHaveLength(2);
  });
});
