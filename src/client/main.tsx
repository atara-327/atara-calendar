import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/700.css';
import './global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('#root が見つかりません');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
