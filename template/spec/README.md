# 仕様の書き方

開発者が作成・維持する仕様入力は [PROJECT.md](PROJECT.md) だけです。[PROJECT.template.md](PROJECT.template.md) は任意の記入例です。初期のdraftとTEMPLATE_NOT_CONFIGUREDを消し、Mod ID、目的、機能、観測できる結果、必要な制約・非対象範囲を書いてください。AC ID、TASKファイル、検証表、milestone境界はHarnessが生成します。

```sh
node .harness/cli.mjs doctor
node .harness/cli.mjs develop --plan-only
node .harness/cli.mjs develop --resume
```

一度に実行する場合は `node .harness/cli.mjs develop` です。仕様が変わったらPROJECT.mdを編集し、`develop` または `develop --resume --replan` を実行します。古い未完了計画は使われません。製品挙動を左右する曖昧さは `NEEDS_PROJECT_CLARIFICATION` として報告されるため、PROJECT.mdへ答えを書いて再実行してください。

機能は操作と結果で記述してください。保存、マルチプレイ、画像、互換性、失敗時の動作が必要なら明記します。Java class名や内部の実装順序を指定する必要はありません。詳しくは [仕様ガイド](../.harness/docs/ai/SPEC_WRITING.md) を参照してください。
