import type { HistoryPort } from '../../src/client/historyMark';

/**
 * ブラウザの履歴の偽物。pushState は、先の履歴を捨てて、積む。back は、すぐには動かず（実際のブラウザも
 * 非同期）、flush で動いて、popstate を起こす。
 */
export class FakeHistory implements HistoryPort {
  readonly entries: unknown[] = [null];
  index = 0;
  private pendingBacks = 0;
  private listeners = new Set<() => void>();

  get state(): unknown {
    return this.entries[this.index];
  }

  pushState(state: unknown): void {
    this.entries.splice(this.index + 1);
    this.entries.push(state);
    this.index += 1;
  }

  back(): void {
    this.pendingBacks += 1;
  }

  /** 頼まれた「戻る」を、すべて実行する。 */
  flush(): void {
    while (this.pendingBacks > 0) {
      this.pendingBacks -= 1;
      this.move(-1);
    }
  }

  /** 利用者が、ブラウザの「戻る」を押す。 */
  userBack(): void {
    this.move(-1);
  }

  /** 利用者が、ブラウザの「進む」を押す。 */
  userForward(): void {
    this.move(1);
  }

  private move(delta: number): void {
    const next = this.index + delta;
    if (next < 0 || next >= this.entries.length) return;
    this.index = next;
    for (const listener of this.listeners) listener();
  }

  readonly onPopState = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}
