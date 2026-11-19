import { Component, type ReactNode } from 'react';
import styles from './FormLoadBoundary.module.css';
import { closeEntryForm } from './instance';
import { resetEntryFormLoad } from './lazyEntryForm';

type Props = { children: ReactNode };
type State = { failed: boolean };

/**
 * フォームのファイルを読めなかったとき（新しい版のページを受け取った直後に電波が切れた、など）、フォームを閉じて知らせる。
 * 受け止めないと、React が root ごと外して、画面が白くなる。
 * 知らせは、画面下の列（BottomNotices）ではなく、ここで持つ。あちらは同期の状態や削除の取り消しの知らせ用で、
 * 1 つの知らせのために、仕組みを広げたくないため。FormHost が、開くたびに key を替えるので、次に開くときには消える。
 */
export class FormLoadBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(): void {
    resetEntryFormLoad();
    closeEntryForm();
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p className={styles.notice} role="alert">
        <span>フォームを読み込めませんでした。電波のある所で、もう一度開いてください</span>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            this.setState({ failed: false });
          }}
        >
          閉じる
        </button>
      </p>
    );
  }
}
