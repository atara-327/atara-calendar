import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/700.css';
import './global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getSyncEngine } from './sync/instance';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('#root が見つかりません');
}

// 同期は、画面の描画（React の再描画）とは別に、アプリが開いている間、1 つだけ動かす。
// 画面の部品の中で始めると、StrictMode（開発時）が部品を 2 回作って、錠を取り直す。
void getSyncEngine()
  .start()
  .catch((error: unknown) => {
    console.error('同期を始められませんでした', error);
  });

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
