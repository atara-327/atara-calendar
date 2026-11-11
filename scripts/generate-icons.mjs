// public/icons/icon.svg から、PNG（192・512・maskable 512）を作る（設計書 14.1）。
// 実行: npx playwright install chromium のあとに、npm run gen:icons（ブラウザは、npm install では入らない）。作った PNG はコミットする。
// Why ビルドのたびに作らないのか: ブラウザを要する道具をビルドに入れたくなく、アイコンはめったに変わらないため。
// Why maskable も同じ絵なのか: SVG が、最初から中心の安全な領域に収まっているため。
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const svg = readFileSync('public/icons/icon.svg', 'utf8');
const targets = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'icon-maskable-512.png', size: 512 },
];

const browser = await chromium.launch();
try {
  for (const { name, size } of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0}svg{display:block;width:${String(size)}px;height:${String(size)}px}</style>${svg}`,
    );
    writeFileSync(`public/icons/${name}`, await page.screenshot({ type: 'png' }));
    await page.close();
  }
} finally {
  await browser.close();
}
