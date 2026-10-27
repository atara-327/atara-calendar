import { useStore } from 'zustand';
import { browserHistoryEnv } from '../historyMark';
import {
  createSidebarController,
  type SidebarController,
  type SidebarState,
} from './sidebarController';

let controller: SidebarController | null = null;

/**
 * 画面で使う、サイドメニューの状態（1 つだけ）。最初に呼ばれたときに作る。
 * 作るのを、モジュールの読み込み時にしないのは、読み込んだだけで、window に触れないため（form/instance.ts と同じ）。
 */
export function getSidebarController(): SidebarController {
  controller ??= createSidebarController(browserHistoryEnv());
  return controller;
}

export function openSidebar(): void {
  getSidebarController().open();
}

export function openWorkspaceEditor(): void {
  getSidebarController().openEditor();
}

export function closeSidebar(): void {
  getSidebarController().close();
}

export function useSidebarState<T>(selector: (state: SidebarState) => T): T {
  return useStore(getSidebarController().store, selector);
}
