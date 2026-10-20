import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), cloudflare()],
  // 画面と Worker に組み込んだ依存パッケージのライセンス全文を、ビルドの成果物に含める。
  // MIT などは、配布物に著作権表示と許諾文を含めることが条件のため（ソースのコメントはバンドル時に消える）。
  build: { license: { fileName: 'third-party-licenses.md' } },
});
