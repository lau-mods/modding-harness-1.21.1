# Project specification template

Status: draft

山括弧で囲んだ記入欄を自分の仕様へ置き換えてください。非該当項目はその理由を書き、未解決事項がなくなってからStatusをreadyへ変更します。特定のMod、機能、生成ファイルは前提にしません。

## Identity

Mod ID: <FILL_MOD_ID>

表示名: <FILL_DISPLAY_NAME>
対象: Minecraft Java 1.21.1 / NeoForge / Java 21。
言語・配布ライセンス: <FILL_LANGUAGES_AND_LICENSE>

## Purpose

<FILL_PURPOSE: 誰が、どの状況で、何をできるようにするか>

## Functional requirements

<FILL_BEHAVIOR: 初期状態、入力・操作、観測できる結果、必要な境界条件>

## Acceptance criteria

- AC-<FILL_ID>: <FILL_INITIAL_STATE> のとき <FILL_ACTION> を行うと <FILL_OBSERVABLE_RESULT> になる。

必要な条件ごとに行を追加し、IDを一意にしてください。曖昧な「正しく動く」ではなく、合否を観測できる結果を書きます。

## Visual requirements

<FILL_VISUAL_REQUIREMENTS: 対象AC、外観・配置・文字・視点の条件。視覚要件がなければ理由>

## Persistence

<FILL_PERSISTENCE: 保存する状態、保存単位、寿命、再起動・削除・移行時の挙動>

## Multiplayer

<FILL_MULTIPLAYER: 対応範囲、状態の確定側、同期、同時操作、権限、導入が必要な側>

## Compatibility

<FILL_COMPATIBILITY: 必要な他Modやresource pack、既存worldとの互換性、対応しない組合せ>

## Non-goals

<FILL_NON_GOALS: 今回作らない隣接機能・連携・対応範囲。必須。未指定の機能追加を許可しない>

## Reference assets

<FILL_REFERENCES: 必要な資料へのリンク、出典、利用条件、参考にする特徴。なければ「なし」>

## Unresolved questions

<FILL_QUESTIONS: 挙動の決定に必要な未解決事項。なければ「なし」。未解決の間はStatusをdraftにする>

## Verification

すべてのACへ検証方法を割り当てます。Evidenceはそのprojectで作成するtest/resourceのpath、scenario ID、またはscenario ID/screenshot IDです。実装後のvalidateまでに参照先が必要です。class名やresource名をハーネスの規約として固定しません。

| AC | Method | Evidence |
| --- | --- | --- |
| AC-<FILL_ID> | <FILL_METHOD> | <FILL_EVIDENCE> |
