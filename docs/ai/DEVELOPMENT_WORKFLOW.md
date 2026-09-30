# Development workflow

1. 具体的な仕様、AC、Non-goalsを確定する。
2. Codex Solが実装、deterministic tests、必要なE2E scenarioを作る。safe build/testは継続して実行できる。
3. JSON・local resource・spec/Mod ID・documentation linkを検査し、harness tests、Gradle classes/testを実行する。
4. Claude Opusが隔離snapshotをread-only reviewする。必要なstructured findingsのみCodexへ返し、修正後は3へ戻る。
5. pass後にGradle build、適用可能なNeoForge GameTestを実行する。
6. 変更分類がruntime検証を必要とする場合だけ、専用ローカル環境で全scenarioを1sessionにまとめる。
7. deterministic preconditionsを通過した必要な画像だけOpusへ渡す。
8. runtime/visual修正も静的検証・code review・build・GameTestを通す。resourceだけなら有効化済みloose packを更新してreloadする。Java/registry/network/metadata変更は再起動する。

defaultはcode candidate/review最大3回、client boot最大2回、runtime/visual batch最大2回。最終回のfindingを残したままpassにしない。失敗したprocess、予算超過、不足runtimeはsummaryに残して停止する。GameTestのheadless server起動はclient bootには数えない。

最初のclient bootは完成候補、2回目はruntime/visual不具合の確認に使う。scenarioごとに再起動しない。no-GameTestはnot-applicableでありMod失敗ではない。build/GameTest失敗も同じ有限candidate予算の中で修正し、再検証・再レビューする。外部review CLI自体の失敗をModのvisual defectと誤認して修正しない。

developは開始時のhashと既存差分を保存する。既存ユーザー差分もreview/classificationへ含める。commit・reset・stashはしない。reviewer会話を再利用せず、毎回独立したCLI runを使用する。クラッシュ後の再実行は新しいrunとなり、古いworld/artifactを削除しない。
