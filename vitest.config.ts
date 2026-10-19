import { defineConfig } from 'vitest/config';

// vite.config.ts とは別にする。Cloudflare の Vite プラグインをテストで読み込むと、
// Workers のランタイムの起動まで走ってしまい、純粋な計算のテストが重くなるため。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
