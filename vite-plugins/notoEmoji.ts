import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { z } from 'zod';

// 絵文字の画像（Noto Color Emoji。設計書 11.1）を、ビルドのときに SVG のファイルとして作る。
//
// 画像のファイルをリポジトリに入れないのは、3,700 個・約 24MB の生成物で、リポジトリが大きくなるため。
// 版は package-lock が固定し、改ざんは npm が検査する。ビルドで GitHub と通信することもない。
//
// @iconify/utils（Iconify 公式の、アイコンを SVG にするライブラリ）を使わないのは、ここで要る変換が
// 「<svg> で包む」だけで、依存を増やす理由がないため。包むだけで済むのは、画像がすべて 128×128 で、
// 使う画像に変形（hFlip・rotate など）も alias（別名）もないため（今の版で確かめた）。
// 将来の版でそうでなくなったら、黙って崩れるより、ビルドを失敗させる。

const VIRTUAL_MODULE_ID = 'virtual:noto-emoji';
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;

/** 画面でだけ使う画像なので、client の環境にだけ出す（Worker の成果物には入れない）。 */
const CLIENT_ENVIRONMENT = 'client';

// xmlns:xlink を宣言するのは、画像の一部（今の版では、使わないものだけ）が xlink:href を使うため。
// 宣言がないと、単独の SVG ファイルは、XML として壊れる。
const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 128 128">';

// 画面が URL を作るときの key。符号位置を 16 進の小文字で、4 桁に 0 埋めして `-` でつなぐ。
// 異体字セレクタ（fe0f）は含まない（画面側が取り除いてから引く。src/client/emoji/）ので、含む key があれば失敗させる。
const keySchema = z
  .string()
  .regex(/^[0-9a-f]{4,6}(-[0-9a-f]{4,6})*$/)
  .refine((key) => !key.split('-').includes('fe0f'), 'fe0f を含む key は、画面側が引けない');

const packageSchema = z.object({ version: z.string().min(1) });
// key → 画像の名前。
const charsSchema = z.record(keySchema, z.string());
// アイコンの一覧の一番上には、全アイコンに効く既定値（left・top・rotate・hFlip・vFlip）を置ける。
// z.object は、知らないキーを黙って捨てるので、これらが来たら失敗させる（画像ごとの確認は、readSvgs にある）。
const noDefault = z.never().optional();
const iconSetSchema = z.object({
  width: z.literal(128),
  height: z.literal(128),
  left: noDefault,
  top: noDefault,
  rotate: noDefault,
  hFlip: noDefault,
  vFlip: noDefault,
  icons: z.record(z.string(), z.looseObject({ body: z.string() })),
});

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** `@iconify-json/noto` のファイルを探す。 */
function packageFile(name: string): string {
  return createRequire(import.meta.url).resolve(`@iconify-json/noto/${name}`);
}

/** 画像のある key の一覧（chars.json）。小さいので、仮想モジュールの読み込みでも使う。 */
function readChars(): Record<string, string> {
  return charsSchema.parse(readJson(packageFile('chars.json')));
}

/**
 * key → SVG。icons.json は約 25MB なので、画像が必要になったとき（ビルド・開発サーバーへの最初のリクエスト）に
 * 初めて読む。設定ファイルを読み込むとき（`vite` の起動ごと）には読まない。
 */
function readSvgs(): Map<string, string> {
  const { icons } = iconSetSchema.parse(readJson(packageFile('icons.json')));
  const svgs = new Map<string, string>();
  for (const [key, name] of Object.entries(readChars())) {
    const icon = icons[name];
    if (icon === undefined) {
      throw new Error(
        `絵文字 ${key} の画像 "${name}" が icons にありません（alias を指している？）`,
      );
    }
    const extra = Object.keys(icon).filter((property) => property !== 'body');
    if (extra.length > 0) {
      throw new Error(
        `絵文字 ${key} の画像 "${name}" が body 以外（${extra.join('・')}）を持っています`,
      );
    }
    svgs.set(key, `${SVG_OPEN}${icon.body}</svg>\n`);
  }
  return svgs;
}

/**
 * Apache-2.0 は、配布物にライセンス全文を含めること（4(a)）と、変更したファイルに、変更した旨を示すこと（4(b)）が条件。
 * パッケージにライセンスのファイルがないので、公式の全文（https://www.apache.org/licenses/LICENSE-2.0.txt）を
 * リポジトリの third_party/ に置く。出どころ・元の著作権表示・変更した旨の見出しを付けて、画像と同じ場所に出す。
 * 見出しの著作権表示は、noto-emoji の 2D/svg/LICENSE のとおり。直下の LICENSE は、フォント用の SIL OFL で、
 * この画像には当たらない。
 */
function readLicense(version: string): string {
  const text = readFileSync(
    join(import.meta.dirname, '../third_party/noto-emoji/LICENSE.txt'),
    'utf8',
  );
  return [
    'Noto Emoji images',
    'Copyright 2013 Google, Inc. All Rights Reserved.',
    'Source: https://github.com/googlefonts/noto-emoji/blob/main/2D/svg/LICENSE',
    '',
    'These files are not the originals. They were generated at build time from the Iconify JSON',
    `(@iconify-json/noto ${version}, https://github.com/iconify/icon-sets) by wrapping each icon in an <svg> element.`,
    '',
    'Licensed under the Apache License, Version 2.0. The full text follows.',
    '',
    text,
  ].join('\n');
}

export function notoEmoji(): Plugin {
  const { version } = packageSchema.parse(readJson(packageFile('package.json')));
  // URL に版を入れるのは、public/_headers で長くキャッシュさせても（immutable）、
  // パッケージを上げたときに、古い画像が残らないようにするため。
  const baseUrl = `/emoji/${version}/`;
  let svgs: Map<string, string> | undefined;
  const getSvgs = () => (svgs ??= readSvgs());

  return {
    name: 'noto-emoji',

    resolveId(id) {
      return id === VIRTUAL_MODULE_ID ? RESOLVED_VIRTUAL_MODULE_ID : undefined;
    },

    load(id) {
      if (id !== RESOLVED_VIRTUAL_MODULE_ID) return undefined;
      // 配列ではなく 1 つの文字列を分けるのは、3,700 個の文字列の配列より、読み込みが軽いため。
      const keys = Object.keys(readChars()).join(' ');
      return [
        `export const EMOJI_BASE_URL = ${JSON.stringify(baseUrl)};`,
        `export const EMOJI_KEYS = new Set(${JSON.stringify(keys)}.split(' '));`,
        '',
      ].join('\n');
    },

    // vite dev は、ビルドの成果物と同じ URL の画像を、その場で返す。
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0];
        if (path === undefined || !path.startsWith(baseUrl) || !path.endsWith('.svg')) {
          next();
          return;
        }
        const svg = getSvgs().get(path.slice(baseUrl.length, -'.svg'.length));
        if (svg === undefined) {
          next();
          return;
        }
        response.setHeader('Content-Type', 'image/svg+xml');
        response.end(svg);
      });
    },

    // emitFile（Rollup の標準のやり方）にしないのは、Vite のビルドの報告が、出した画像 3,700 個を、
    // 1 つずつログに出し、gzip の大きさも 1 つずつ計算するため（CI のログが 4,000 行を超える）。
    // writeBundle は、出力先の掃除（emptyOutDir）のあとに動くので、掃除で消されることはない。
    writeBundle(options) {
      if (this.environment.name !== CLIENT_ENVIRONMENT) return;
      if (options.dir === undefined) throw new Error('出力先のディレクトリが分かりません');
      const directory = join(options.dir, 'emoji', version);
      mkdirSync(directory, { recursive: true });
      for (const [key, svg] of getSvgs()) {
        writeFileSync(join(directory, `${key}.svg`), svg);
      }
      writeFileSync(join(directory, 'LICENSE.txt'), readLicense(version));
    },
  };
}
