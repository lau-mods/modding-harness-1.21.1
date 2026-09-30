# Example: Copper Counter（記入例）

Status: draft

この例を自分の仕様へ置き換え、完成したらStatusをreadyへ変更します。

## Identity

Mod ID: copper_counter

表示名: Copper Counter。対象: Minecraft Java 1.21.1 / NeoForge / Java 21。
言語: en_us、ja_jp。配布ライセンス: MIT（選定例）。

## Purpose

拠点の入口で来訪回数を簡単に数え、再ログイン後も確認できる。

## Functional requirements

- 設置した銅色のカウンターを空の手で右クリックすると、そのブロックの値が1増える。
- 操作者のaction barへ現在値を表示する。上限は999、上限以降は999のまま。
- 破壊して再設置すると0から始まる。クリエイティブタブから入手する。

## Acceptance criteria

- AC-COUNT: 値0のブロックを空の手で3回操作したとき、順に1、2、3が表示される。
- AC-LIMIT: 値999で操作しても999のままで、負数や例外が発生しない。
- AC-SAVE: 値3でworldを保存終了し、再起動後に1回操作すると4が表示される。
- AC-MULTI: 2人が同じブロックを合計10回操作したとき値は10になり、どちらからも同じ値を観測する。
- AC-VISUAL: 明るい平原の昼、正面から見て銅色の筐体に白い目盛りが見え、missing textureや面のちらつきがない。

## Visual requirements

AC-VISUALに対応。vanillaの銅に近い色、16x16のpixel texture。内部実装方法は指定しない。
正面・背面とinventory内のitemの向きが自然なこと。GUIは追加しない。

## Persistence

各設置ブロックの値をworldに保存する。破壊時は値を持ち越さない。古いworldからの移行対応は不要。

## Multiplayer

専用server対応。同時操作で増分を失わない。両側にModを導入する。権限や所有者制限は設けない。

## Compatibility

NeoForge 1.21.1のみ。標準resource packで動作する。他ModのAPIとの特別な連携は不要。

## Non-goals

- recipe、自動化、redstone出力、ネットワーク共有、GUI、ランキングを作らない。
- Fabric/Forgeへのport、他Minecraft version、economy連携は行わない。
- アイテムに値を保存しない。999を超える拡張設定を作らない。

## Reference assets

現在なし。参考画像を追加する場合は `references/` に保存し、出典・権利・参考にする特徴を記入する。

## Unresolved questions

なし。機能に影響する未解決の選択がある間はStatusをdraftにする。
