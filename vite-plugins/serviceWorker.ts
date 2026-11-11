import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import type { Plugin } from 'vite';
import { isPrecached } from '../src/sw/rules.ts';

// Service Worker（src/sw/sw.ts。設計書 14.2）を、ビルドの出力から作る。
//
// 一覧と版を埋め込むため、vite の通常の entry にはしない（entry だと、ファイル名に hash が付き、一覧も知れない）。
// 版は、画面のファイル名（中身の hash を含む）から作る。ファイルが変われば、必ず版が変わる。

/** 画面だけの成果物なので、client の環境にだけ出す（Worker の成果物には入れない）。 */
const CLIENT_ENVIRONMENT = 'client';

export function serviceWorker(): Plugin {
  return {
    name: 'service-worker',
    apply: 'build',

    async generateBundle(_options, bundle) {
      if (this.environment.name !== CLIENT_ENVIRONMENT) return;
      const urls = Object.keys(bundle)
        .map((file) => `/${file}`)
        .filter(isPrecached)
        .sort();
      const version = createHash('sha256').update(urls.join('\n')).digest('hex').slice(0, 12);
      const result = await build({
        entryPoints: ['src/sw/sw.ts'],
        bundle: true,
        write: false,
        format: 'iife',
        target: 'es2022',
        minify: true,
        define: {
          __BUILD_VERSION__: JSON.stringify(version),
          __PRECACHE_URLS__: JSON.stringify(urls),
        },
      });
      const output = result.outputFiles[0];
      if (output === undefined) throw new Error('sw.js を作れませんでした');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: output.contents });
    },
  };
}
