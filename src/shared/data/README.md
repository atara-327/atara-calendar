# src/shared/data

`solarTerms.ts`（春分・夏至・秋分・冬至・立春の天文計算）が使うデータです。

## vsop87-earth-truncated.json

地球の軌道を表す VSOP87 の級数を、振幅の小さい項を捨てて小さくしたものです。**手で編集せず、下の手順で作り直してください。**

### 元のデータ

| 項目 | 内容 |
| --- | --- |
| 元 | [astronomia](https://github.com/commenthol/astronomia) 4.2.0 の `data/vsop87Bearth.js`（VSOP87 の地球、版 B） |
| 理論 | VSOP87（P. Bretagnon, G. Francou, Astronomy & Astrophysics 202, 309, 1988） |
| ライセンス | MIT（下に全文） |

### 間引き方

- 項 `[A, B, C]`（振幅・位相・周波数）のうち、`|A| >= 1e-7` のものだけを残します。残った項は 220 項（元は 2,564 項）です。
- データの形は元と同じ（`{ L: {"0": [[A, B, C], ...], ...}, B: {...}, R: {...}, name, type }`）です。項が 1 つも残らない次数も、空の配列として残します。
- サイズは約 127KB（gzip で約 41KB）から、約 9.5KB（gzip で約 3.8KB）になります。
- 1900〜2199 年の 5 つの節気（立春・春分・夏至・秋分・冬至）で、元のデータで求めた瞬間との差は最大約 7 秒です。日付の判定には十分です。テスト（`solarTerms.test.ts`）が、30 秒以内に収まることを確かめています。

### 作り直し方

```sh
npm ci
npm run gen:vsop87
```

astronomia の版を上げたとき、または振幅のしきい値（`scripts/generate-vsop87-earth.mjs` の `MIN_AMPLITUDE`）を変えたときに実行します。生成した JSON はコミットします。

### 元データのライセンス（astronomia 4.2.0 の LICENSE）

```
The MIT License (MIT)

Copyright (c) 2013 Sonia Keys
Copyright (c) 2016 Commenthol

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
