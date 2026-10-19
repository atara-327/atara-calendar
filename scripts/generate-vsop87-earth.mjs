// astronomia の VSOP87（地球）から、振幅の小さい項を捨てた JSON を作る。
// 捨てる理由と、作り直す手順は src/shared/data/README.md。
import { writeFileSync } from 'node:fs';
import earth from 'astronomia/data/vsop87Bearth';

const MIN_AMPLITUDE = 1e-7;
const OUTPUT = new URL('../src/shared/data/vsop87-earth-truncated.json', import.meta.url);

/**
 * 項が 1 つも残らない次数（"4"・"5" など）も、空の配列として残す。
 * astronomia は次数のキーを順に並べて多項式を作るので、キーを飛ばすと次数がずれるため。
 * @param {Record<string, readonly (readonly number[])[]>} series
 */
function truncateSeries(series) {
  return Object.fromEntries(
    Object.entries(series).map(([power, terms]) => [
      power,
      terms.filter(([amplitude]) => Math.abs(amplitude ?? 0) >= MIN_AMPLITUDE),
    ]),
  );
}

const truncated = {
  L: truncateSeries(earth.L),
  B: truncateSeries(earth.B),
  R: truncateSeries(earth.R),
  name: earth.name,
  type: earth.type,
};

// 空白を入れないのは、画面のバンドルに入るデータを少しでも小さくするため。
writeFileSync(OUTPUT, `${JSON.stringify(truncated)}\n`);

const count = (/** @type {Record<string, unknown[]>} */ series) =>
  Object.values(series).reduce((sum, terms) => sum + terms.length, 0);
console.log(
  `項の数 L=${String(count(truncated.L))} B=${String(count(truncated.B))} R=${String(count(truncated.R))}`,
);
