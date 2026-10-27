import { MenuIcon } from '../form/icons';
import styles from './MenuButton.module.css';
import { openSidebar } from './instance';

/**
 * サイドメニューを開く ≡（設計書 11.5）。月表示と日表示のヘッダーの左端に置く。
 * 最初の読み込みの前でも、押せる。メニューの中の、チェックボックスと編集のボタンが、読み込みの前は押せない
 * （SidebarMenu.tsx）。
 */
export function MenuButton() {
  return (
    <button type="button" className={styles.button} aria-label="メニュー" onClick={openSidebar}>
      <MenuIcon />
    </button>
  );
}
