import { SidebarMenu } from './SidebarMenu';
import { WorkspaceEditor } from './WorkspaceEditor';
import { useSidebarState } from './instance';

/**
 * 開いているサイドメニュー、または、ワークスペースの編集を出す。閉じているときは何も出さない。
 * メニューから編集へ移るとき、メニューのダイアログを閉じて、編集のダイアログを開く（履歴は積み直さない。
 * sidebarController.ts）。
 */
export function SidebarHost() {
  const view = useSidebarState((state) => state.view);
  if (view === 'menu') return <SidebarMenu />;
  if (view === 'editor') return <WorkspaceEditor />;
  return null;
}
