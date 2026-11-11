import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import type { Plugin } from 'vite';
import { isPrecached } from '../src/sw/rules.ts';

// Service Worker（src/sw/sw.ts。設計書 14.2）を、ビルドの出力から作る。
//
// 一覧と版を埋め込むため、vite の通常の entry にはしない（entry だと、ファイル名に hash が付き、一覧も知れない）。
// 版は、画面のファイル名（中身の hash を含む）・index.html の中身・Service Worker のコードから作る。どれが変わっても、版が変わる。

/** 画面だけの成果物なので、client の環境にだけ出す（Worker の成果物には入れない）。 */
const CLIENT_ENVIRONMENT = 'client';

export function serviceWorker(): Plugin {
  return {
    name: 'service-worker',
    apply: 'build',
    // index.html を作るプラグインのあとに動かし、bundle に index.html が入っているようにする。
    enforce: 'post',

    async generateBundle(_options, bundle) {
      if (this.environment.name !== CLIENT_ENVIRONMENT) return;
      const urls = Object.keys(bundle)
        .map((file) => `/${file}`)
        .filter(isPrecached)
        .sort();
      const html = bundle['index.html'];
      if (html?.type !== 'asset') throw new Error('bundle に index.html がありません');

      const bundleSw = async (version: string, codeHash: string, precache: readonly string[]) => {
        const result = await build({
          entryPoints: ['src/sw/sw.ts'],
          bundle: true,
          write: false,
          format: 'iife',
          target: 'es2022',
          minify: true,
          define: {
            __BUILD_VERSION__: JSON.stringify(version),
            __CODE_HASH__: JSON.stringify(codeHash),
            __PRECACHE_URLS__: JSON.stringify(precache),
          },
        });
        const output = result.outputFiles[0];
        if (output === undefined) throw new Error('sw.js を作れませんでした');
        return output.contents;
      };
      const hash = (...parts: (string | Uint8Array)[]) => {
        const h = createHash('sha256');
        for (const part of parts) h.update(part).update('\0');
        return h.digest('hex').slice(0, 12);
      };

      // 1 回目は、版と一覧を空にして作る。sw.ts・rules.ts だけを直したときも版が変わるように、コードの hash を求めるため。
      // 使ったときに保存するものの名前にも、この hash を使う（アプリの版が変わっても、消えないように）。
      const codeHash = hash(await bundleSw('', '', []));
      const version = hash(urls.join('\n'), html.source, codeHash);
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: await bundleSw(version, codeHash, urls),
      });
    },
  };
}
