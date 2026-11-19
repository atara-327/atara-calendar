/** 光ってから元に戻るまでの長さ（設計書 11.2）。 */
const FLASH_MS = 1000;
/** 今日のマスが描かれるのを待つ、最大のフレーム数（約 0.5 秒）。 */
const MAX_WAIT_FRAMES = 30;

/**
 * 今日のマスを、明るくしてから、元の色にフェードアウトさせる（［今日］を押したとき。設計書 11.2）。
 * スクロールした直後は、仮想スクロールが行をまだ描いていないことがあるので、マスが出るまでフレームごとに探す。
 * Why not 今日のマスに「光らせる」状態を props で渡す: memo した行（MonthRow）を全部描き直すことになり、
 * 一瞬の見た目のために、行の比較の条件を増やしたくないため。
 */
export function flashToday(scrollElement: HTMLElement): void {
  let frames = 0;
  const tryFlash = () => {
    const cell = scrollElement.querySelector<HTMLElement>('[aria-current="date"]');
    if (cell === null) {
      frames += 1;
      if (frames < MAX_WAIT_FRAMES) requestAnimationFrame(tryFlash);
      return;
    }
    cell.animate(
      [
        { backgroundColor: 'rgb(138 180 248 / 40%)' },
        { backgroundColor: getComputedStyle(cell).backgroundColor },
      ],
      { duration: FLASH_MS, easing: 'ease-out' },
    );
  };
  requestAnimationFrame(tryFlash);
}
