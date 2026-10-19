# テストの正解データ

祝日・記念日の計算（設計書8章）が正しいかを確かめるための、公式の一覧です。テストはこのファイルと計算結果を突き合わせます。
中身は手で書き換えず、更新するときは下の手順で入手し直してください。

## syukujitsu.csv（祝日）

| 項目 | 内容 |
| --- | --- |
| 入手元 | 内閣府「国民の祝日について」の CSV（https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv） |
| 取得日 | 2026-10-19 |
| 範囲 | 1955年〜2027年 |
| 変換 | 文字コードを Shift_JIS から UTF-8 に、改行を CRLF から LF に変えただけ（中身は変えていない） |
| 元ファイルの SHA-256 | `cec37a743c96995cdb9cb52b685c9003634682a9b0e1a640a6b9b96881fe964a` |

更新の手順（翌年の分が公表されたら）:

```sh
curl -sS -o /tmp/syukujitsu.csv https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv
iconv -f SHIFT_JIS -t UTF-8 /tmp/syukujitsu.csv | tr -d '\r' > test/fixtures/syukujitsu.csv
```

## naoj-solar-terms.csv（立春・春分・夏至・秋分・冬至の日時）

| 項目 | 内容 |
| --- | --- |
| 入手元 | 国立天文台 暦計算室「暦要項」の「二十四節気および雑節」（https://eco.mtk.nao.ac.jp/koyomi/yoko/ の各年の `rekiyou{年の下2桁}2.html`） |
| 取得日 | 2026-10-19 |
| 範囲 | 2004年〜2027年（Web で公開されている年） |
| 列 | 年, 名前, 太陽の黄経（度）, 日付, 時刻（日本時間。暦要項の表記どおり分まで） |
| 変換 | 各年のページの表から、立春・春分・夏至・秋分・冬至の行だけを抜き出した |

内閣府の一覧には夏至・冬至・立春（節分の計算に使う）がないため、国立天文台の値を正解にしている。
