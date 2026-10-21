import type { ComponentPropsWithoutRef, MouseEvent } from 'react';
import { navigate } from './navigation';

type LinkProps = Omit<ComponentPropsWithoutRef<'a'>, 'href'> & { to: string };

function isPlainLeftClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * 画面の中の移動。普通のリンク（`<a href>`）として出すので、新しいタブで開く・URL をコピーするといった、
 * ブラウザの操作も使える。ふつうのクリックだけ、ページを読み込み直さずに navigate で移る。
 */
export function Link({ to, onClick, ...props }: LinkProps) {
  return (
    <a
      {...props}
      href={to}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !isPlainLeftClick(event)) return;
        event.preventDefault();
        navigate(to);
      }}
    />
  );
}
