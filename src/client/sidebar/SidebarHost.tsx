import { SidebarMenu } from './SidebarMenu';
import { useSidebarState } from './instance';

/** 開いているサイドメニューを出す。閉じているときは何も出さない。 */
export function SidebarHost() {
  const view = useSidebarState((state) => state.view);
  if (view === 'menu') return <SidebarMenu />;
  return null;
}
