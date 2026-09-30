# 仕様の書き方

[spec/README](../../spec/README.md)の手順と[記入欄](../../spec/PROJECT.template.md)を使う。section名はvalidatorが認識するため保ち、本文は自由な自然言語で書ける。独自DSLは不要。

目的には「誰が何をできるようになるか」を書く。identityにはMod ID・表示名・対象version・言語・ライセンスを記載する。機能は正常系に加え、空、満杯、権限不足、同時操作、再起動など必要な境界を観測可能な結果で説明する。Javaのclass名やpatternを先に指定しない。

ACには一意な `- AC-<ID>: ...` を付ける。「便利」「綺麗」「正しく保存」だけでは検証できない。「初期状態／操作／観測できる結果」の形で記述する。どの層で検証するかは実装担当が判断し、レビュー担当が根拠を確認する。

visual requirementsには対象AC、色・形・pixel style・サイズ・GUI配置、必要な視点を書く。GUIがないならそう明記する。参照画像は出典と利用条件、真似する特徴と真似しない特徴を添える。画像の全pixel一致を要求する場合はrenderer/font/OS差も仕様として扱う。

persistenceは保存単位、寿命、破壊時、再起動時、既存world migrationを説明する。multiplayerはserver authoritativeな結果、同時操作、同期、権限、client/server双方への導入要否を定める。compatibilityは対象loader/versionと特別に必要な他Mod/resource packを列挙し、対象外も明記する。

**Non-goalsを空にしない。** 「自動化しない」「GUIなし」「他loader対応なし」「設定screenなし」など、隣接するが今回実装しない機能を挙げる。AIは未指定の便利機能やgeneral frameworkを発明しない。

unresolved questionsは、本当に判断不能でobservable behaviorに影響する事項だけを書く。実装手段の通常判断はagentに任せる。未解決の製品判断が残るなら `Status: draft` を維持する。readyへの変更は仕様の合意を表し、agentは勝手に変更しない。

## AC verification assignments

すべての `- AC-ID: ...` をrequiredとして扱い、`## Verification` に3列のMarkdown tableを置きます。1 ACへ複数行を割り当てられます。記入時は適切な方法を決め、実装時にCodexが参照先のtest/scenarioを作成します。未割当・未知AC・存在しない参照はMinecraft起動前に失敗します。割当済みは実行成功とは区別します。

| AC | Method | Evidence |
| --- | --- | --- |
| `AC-<ID>` | gametest | `<GameTest source path>` |
| `AC-<ID>` | e2e | `<scenario ID>` |
| `AC-<ID>` | persistence | `<after-restart scenario ID>` |
| `AC-<ID>` | visual | `<scenario ID>/<screenshot ID>` |

Methodは `unit`（src/testの@Test source）、`static`（src/main/generated resource）、`gametest`（登録された@GameTest source）、`e2e`（scenario id）、`visual`（scenario id/screenshot id）、`multiplayer`（multiplayerを明示するscenario）、`persistence`（after-restart scenario）です。仕様の性質に合う方法を選び、画像ACをunitだけで済ませたり、保存ACをcodec testだけで済ませたりしないでください。適切さは独立code reviewでも確認します。specには行動と期待結果を書き、実装のclass分割を指示しません。

表は構文の説明であり、予約されたACや生成ファイルはない。Mod ID・registry ID・resource path・class名・scenario内容はproject側の仕様・実装・テストに置く。ハーネスは割当表とscenarioを読み、特定Modに対応する分岐や定数を持たない。
