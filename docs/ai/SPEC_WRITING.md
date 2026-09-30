# 仕様の書き方

[spec/README](../../spec/README.md)の手順と[記入例](../../spec/PROJECT.template.md)を使う。section名はvalidatorが認識するため保ち、本文は自由な自然言語で書ける。独自DSLは不要。

目的には「誰が何をできるようになるか」を書く。identityにはMod ID・表示名・対象version・言語・ライセンスを記載する。機能は正常系に加え、空、満杯、権限不足、同時操作、再起動など必要な境界を観測可能な結果で説明する。Javaのclass名やpatternを先に指定しない。

ACには一意な `- AC-NAME: ...` を付ける。「便利」「綺麗」「正しく保存」だけでは検証できない。例えば「空のslotに右クリックすると1個入り、元stackが1減る」「worldを保存終了・再起動しても3個残る」と書く。どの層で検証するかは実装担当が判断し、レビュー担当が根拠を確認する。

visual requirementsには対象AC、色・形・pixel style・サイズ・GUI配置、必要な視点を書く。GUIがないならそう明記する。参照画像は出典と利用条件、真似する特徴と真似しない特徴を添える。画像の全pixel一致を要求する場合はrenderer/font/OS差も仕様として扱う。

persistenceは保存単位、寿命、破壊時、再起動時、既存world migrationを説明する。multiplayerはserver authoritativeな結果、同時操作、同期、権限、client/server双方への導入要否を定める。compatibilityは対象loader/versionと特別に必要な他Mod/resource packを列挙し、対象外も明記する。

**Non-goalsを空にしない。** 「自動化しない」「GUIなし」「他loader対応なし」「設定screenなし」など、隣接するが今回実装しない機能を挙げる。AIは未指定の便利機能やgeneral frameworkを発明しない。仕様変更が必要ならdevelopの外で仕様を更新してから再実行する。

unresolved questionsは、本当に判断不能でobservable behaviorに影響する事項だけを書く。実装手段の通常判断はagentに任せる。未解決の製品判断が残るなら `Status: draft` を維持する。readyへの変更は仕様の合意を表し、agentは勝手に変更しない。
