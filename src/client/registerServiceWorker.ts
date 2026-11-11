// 本番のビルドのときだけ登録する。vite dev で登録すると、保存したファイルが開発中の変更を隠すため。
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
    console.error('Service Worker を登録できませんでした', error);
  });
}
