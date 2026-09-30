# 仕様を記入する

`PROJECT.md` が開発の入口です。初期状態は意図的に `Status: draft` と `TEMPLATE_NOT_CONFIGURED` を含み、実開発を拒否します。`develop --dry-run` は架空の状態遷移を検査するため、このplaceholderを読みません。

1. [PROJECT.template.md](PROJECT.template.md) の例を参考に [PROJECT.md](PROJECT.md) を編集します。例をそのまま承認せず、自分のModの挙動へ書き換えてください。
2. セクション名と `Mod ID:`、`AC-...:` の形式を保ち、内容は日本語で構いません。非該当項目も「不要。その理由」を記入します。
3. 実装に影響する未解決事項を解消し、placeholderを消して `Status: ready` にします。`TODO` / `TBD` は残さないでください。
4. `node harness/cli.mjs develop` を実行します。Mod IDと既存サンプルの違いは実装で更新され、その後validateが整合性を確認します。

仕様は「interfaceを作る」ではなく「満杯のとき投入できずアイテムが失われない」のように、プレイヤーが観測できる結果を書きます。受け入れ条件には一意なIDを付け、入力・初期状態・操作・期待結果を明記します。

**Non-goalsは必須です。** 今回作らない機能、対応しない連携、自由な推測で追加してほしくない挙動を具体的に書きます。未指定の便利機能をAIが追加する許可にはなりません。

大きい仕様だけ `features/` に分け、PROJECTから関連ファイルへリンクします。`references/` に画像や参考資料を置き、出典・利用条件・何を参考にするかを記載します。visual reviewに必要な資料はPROJECTのVisual requirementsまたはReference assetsから通常のMarkdown linkで `references/ファイル名` へリンクしてください。説明のない画像から仕様を推測させないでください。詳しい例・設計基準は [SPEC_WRITING](../docs/ai/SPEC_WRITING.md) を参照してください。
