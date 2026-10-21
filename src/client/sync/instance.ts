import { useStore } from 'zustand';
import { createBrowserEnvironment } from './browser';
import { createSyncEngine, type SyncEngine } from './engine';
import type { SyncState } from './state';

let engine: SyncEngine | null = null;

/**
 * 画面で使う、同期のエンジン（1 つだけ）。最初に呼ばれたときに作る。
 * 作るのを、モジュールの読み込み時にしないのは、読み込んだだけで、IndexedDB や錠に触れないため。
 */
export function getSyncEngine(): SyncEngine {
  engine ??= createSyncEngine(createBrowserEnvironment());
  return engine;
}

/** 同期の状態の一部を、画面で読む。selector は、値が変わらないとき、同じ値（同じ参照）を返すこと。 */
export function useSyncState<T>(selector: (state: SyncState) => T): T {
  return useStore(getSyncEngine().store, selector);
}
