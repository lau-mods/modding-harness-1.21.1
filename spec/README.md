# 仕様を記入する

`PROJECT.md` が開発の入口です。初期状態は意図的に `Status: draft` と `TEMPLATE_NOT_CONFIGURED` を含み、実開発を拒否します。`develop --dry-run` は架空の状態遷移を検査するため、このplaceholderを読みません。

1. [PROJECT.template.md](PROJECT.template.md) の記入欄を使って [PROJECT.md](PROJECT.md) を編集します。すべての `<FILL_...>` を自分のModの仕様へ置き換えてください。
2. セクション名と `Mod ID:`、`AC-...:` の形式を保ち、内容は日本語で構いません。非該当項目も「不要。その理由」を記入します。
3. 実装に影響する未解決事項を解消し、placeholderを消して `Status: ready` にします。`TODO` / `TBD` は残さないでください。
4. `node harness/cli.mjs develop` を実行します。Mod IDと既存サンプルの違いは実装で更新され、その後validateが整合性を確認します。

仕様には実装patternではなく、プレイヤーが観測できる結果を書きます。受け入れ条件には一意なIDを付け、入力・初期状態・操作・期待結果を明記します。

**Non-goalsは必須です。** 今回作らない機能、対応しない連携、自由な推測で追加してほしくない挙動を具体的に書きます。未指定の便利機能をAIが追加する許可にはなりません。

大きい仕様だけ `features/` に分け、PROJECTから関連ファイルへリンクします。`references/` に画像や参考資料を置き、出典・利用条件・何を参考にするかを記載します。visual reviewに必要な資料はPROJECTのVisual requirementsまたはReference assetsから通常のMarkdown linkで `references/ファイル名` へリンクしてください。説明のない画像から仕様を推測させないでください。詳しい例・設計基準は [SPEC_WRITING](../docs/ai/SPEC_WRITING.md) を参照してください。

## AC verification assignments

すべての `- AC-ID: ...` をrequiredとして扱い、`## Verification` に3列のMarkdown tableを置きます。1 ACへ複数行を割り当てられます。記入時は適切な方法を決め、実装時にCodexが参照先のtest/scenarioを作成します。未割当・未知AC・存在しない参照はMinecraft起動前に失敗します。割当済みは実行成功とは区別します。

| AC | Method | Evidence |
| --- | --- | --- |
| `AC-<ID>` | gametest | `<GameTest source path>` |
| `AC-<ID>` | e2e | `<scenario ID>` |
| `AC-<ID>` | persistence | `<after-restart scenario ID>` |
| `AC-<ID>` | visual | `<scenario ID>/<screenshot ID>` |

Methodは `unit`（src/testの@Test source）、`static`（src/main/generated resource）、`gametest`（登録された@GameTest source）、`e2e`（scenario id）、`visual`（scenario id/screenshot id）、`multiplayer`（multiplayerを明示するscenario）、`persistence`（after-restart scenario）です。仕様の性質に合う方法を選び、画像ACをunitだけで済ませたり、保存ACをcodec testだけで済ませたりしないでください。適切さは独立code reviewでも確認します。specには行動と期待結果を書き、実装のclass分割を指示しません。

表は形式の説明です。ID・path・ファイル名はproject側で定め、ハーネス本体や共通文書へ転記しません。
