import { describe, expect, it, vi } from 'vitest';
import { createWebLock } from './lock';

/**
 * Web Locks API の、steal の動きだけを真似た錠の管理。本物の LockManager の型は、request の戻り値が
 * any で、テストに必要な部分だけを持つ偽物を、型を偽らずに渡せないので、最後に 1 回だけ型を合わせる。
 * 本物の動き: steal: true の request は、持っている錠を奪う。奪われた側の request は、AbortError で拒否される。
 */
function fakeLockManager() {
  let holder: { reject: (error: unknown) => void } | null = null;
  const manager = {
    request(
      _name: string,
      _options: { steal: boolean },
      callback: () => Promise<void>,
    ): Promise<unknown> {
      return new Promise((resolve, reject) => {
        if (holder !== null) holder.reject(new DOMException('stolen', 'AbortError'));
        holder = { reject };
        callback().then(resolve, reject);
      });
    },
  };
  return manager as unknown as LockManager;
}

describe('同じ端末の複数のタブ（Q5）', () => {
  it('錠が取れたら、acquire が解決する', async () => {
    const lock = createWebLock(fakeLockManager());
    await expect(lock.acquire(() => undefined)).resolves.toBeDefined();
  });

  it('後から開いたタブが錠を奪うと、先に開いたタブの onLost が呼ばれる', async () => {
    const manager = fakeLockManager();
    const lostA = vi.fn();
    const lostB = vi.fn();
    await createWebLock(manager).acquire(lostA);

    await createWebLock(manager).acquire(lostB);
    await Promise.resolve();

    expect(lostA).toHaveBeenCalledTimes(1);
    expect(lostB).not.toHaveBeenCalled();
  });

  it('3 つ目のタブが開くと、最後に開いたタブだけが動く', async () => {
    const manager = fakeLockManager();
    const lost = [vi.fn(), vi.fn(), vi.fn()];
    for (const onLost of lost) await createWebLock(manager).acquire(onLost);
    await Promise.resolve();

    expect(lost.map((fn) => fn.mock.calls.length)).toEqual([1, 1, 0]);
  });

  it('自分で錠を手放したときは、onLost を呼ばない', async () => {
    const onLost = vi.fn();
    const handle = await createWebLock(fakeLockManager()).acquire(onLost);

    handle.release();
    await Promise.resolve();

    expect(onLost).not.toHaveBeenCalled();
  });

  it('アプリ固有の名前で錠を取る', async () => {
    const request = vi.fn(
      (_name: string, _options: unknown, callback: () => Promise<void>): Promise<unknown> => {
        void callback();
        return new Promise(() => undefined);
      },
    );
    const locks = { request } as unknown as LockManager;

    await createWebLock(locks).acquire(() => undefined);

    expect(request.mock.calls[0]?.[0]).toBe('atara-calendar-sync');
    expect(request.mock.calls[0]?.[1]).toEqual({ steal: true });
  });

  it('navigator.locks がないブラウザでは、調整せずに動かす（警告を出して、錠が取れたものとして扱う）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(createWebLock(undefined).acquire(() => undefined)).resolves.toBeDefined();

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('錠を取れる前に request が失敗したら、acquire を失敗させる', async () => {
    const locks = {
      request: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
    } as unknown as LockManager;

    await expect(createWebLock(locks).acquire(() => undefined)).rejects.toThrow('denied');
  });
});
