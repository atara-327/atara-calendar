// 最初の import にする。zod のスキーマ（./App 以降が読み込む）を作る前に、設定を効かせるため。
import './zodConfig';
import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/700.css';
import './global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getFormController } from './form/instance';
import { getSidebarController } from './sidebar/instance';
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

// フォームの履歴の見張りも、画面の描画とは別に、1 回だけ始める。再読み込みのあとに残った、フォームの履歴の印を、
// 最初に直すため（設計書 11.4）。
getFormController().start();
// サイドメニューも同じ。履歴の印が残っているときの戻し方は、フォームと同じ仕組み（historyMark.ts）。
getSidebarController().start();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
