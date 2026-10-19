import { defineConfig } from 'vitest/config';

// vite.config.ts を使わないのは、Cloudflare の Vite プラグインを読み込んだままだと、
// Vitest が起動時に「There is already a server associated with the config」で止まるため。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
