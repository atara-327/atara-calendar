import { describe, expect, it } from 'vitest';
import { loadLastWorkspaceId, saveLastWorkspaceId } from './lastWorkspace';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

const throwingStorage: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: () => {
    throw new DOMException('使えません', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('いっぱいです', 'QuotaExceededError');
  },
};

describe('EV-8: 前回のワークスペースの記憶（端末の localStorage）', () => {
  it('覚えたワークスペースの id を、次に読める', () => {
    const storage = memoryStorage();

    saveLastWorkspaceId('hobby', storage);

    expect(loadLastWorkspaceId(storage)).toBe('hobby');
  });

  it('まだ覚えていなければ null', () => {
    expect(loadLastWorkspaceId(memoryStorage())).toBeNull();
  });

  it('新しく覚えると、前に覚えたものを置き換える', () => {
    const storage = memoryStorage();

    saveLastWorkspaceId('work', storage);
    saveLastWorkspaceId('hobby', storage);

    expect(loadLastWorkspaceId(storage)).toBe('hobby');
  });

  it('localStorage が使えない環境（プライベートブラウズなど）で、読んでも例外を投げず、null', () => {
    expect(loadLastWorkspaceId(throwingStorage)).toBeNull();
  });

  it('localStorage が使えない環境で、書いても例外を投げない（覚えられないだけ）', () => {
    expect(() => {
      saveLastWorkspaceId('work', throwingStorage);
    }).not.toThrow();
  });

  it('localStorage に触れない（保存先が null）ときも、例外を投げない', () => {
    expect(loadLastWorkspaceId(null)).toBeNull();
    expect(() => {
      saveLastWorkspaceId('work', null);
    }).not.toThrow();
  });
});
