# Development workflow

1. 具体的な仕様、AC、Non-goalsとVerification割当表を確定する。
2. Codex Solが [AGENTS.md](../../AGENTS.md) に従って実装、deterministic tests、必要なE2E scenarioを作る。同じ実装セッションで `validate --agent-fast`（static/resource、Gradle classes/test）を実行し、失敗したら修正して再実行する。成功時のfile hashを候補と照合する。
3. ハーネスがstatic/coverageとharness self-testsを独立に確認する。Codex内で通したGradle classes/testは繰り返さない。
4. Claude Opusが隔離snapshotをread-only reviewする。修正Codexには理由、finding/error、変更ファイル、関連ACだけを渡し、修正後は2へ戻る。harness保守や未確定のユーザー判断が必要な `protected-input` blockerでは停止する。
5. pass後にGradle build、適用可能なNeoForge GameTestを実行する。
6. 変更分類がruntime検証を必要とする場合だけ、専用ローカル環境で全scenarioを1sessionにまとめる。
7. deterministic preconditionsを通過した必要な画像だけOpusへ渡す。
8. runtime/visual修正も静的検証・code review・build・GameTestを通す。resourceだけなら有効化済みloose packを更新してreloadする。Java/registry/network/metadata変更は再起動する。

defaultはcode candidate/review最大3回、client boot最大2回、runtime/visual batch最大2回。client bootは台数分を計上するため、複数playerで必要な予算は [Multiplayer E2E](../../tests/e2e/README.md#multiplayer)を参照する。最終回のfindingを残したままpassにしない。失敗したprocess、予算超過、不足runtimeはsummaryに残して停止する。GameTestのheadless server起動はclient bootには数えない。

1clientの場合、最初のbootは完成候補、2回目はruntime/visual不具合の確認に使う。scenarioごとに再起動しない。no-GameTestはnot-applicableでありMod失敗ではない。build/GameTest失敗も同じ有限candidate予算の中で修正し、再検証・再レビューする。外部review CLI自体の失敗をModのvisual defectと誤認して修正しない。

developは開始時のhashと既存差分を保存する。既存ユーザー差分もreview/classificationへ含める。commit・reset・stashはしない。reviewer会話を再利用せず、毎回独立したCLI runを使用する。クラッシュ後の再実行は新しいrunとなり、古いworld/artifactを削除しない。


保存のACはafter-restart scenarioで確認し、通常batch→保存終了→2回目のsession→既存stateの検証→visual reviewとなる。1clientでも2bootのdefault予算を保存検証で使うため、さらにrestartが必要な修正は予算超過としてevidenceを返す。保存ACがあるprojectでは、resource/scenarioの修正でも保存再起動の再検証に追加bootが必要になる。保存ACがないprojectのresource/scenario修正では稼働sessionを再利用できる。qualificationの失敗後に人間/実装担当が修正して明示的に再実行した場合は新runとして記録し、前runの失敗や実起動回数を隠さない。

E2E scenario/helperだけの変更も初回のruntime検証を必要とする。correction中はrestart/reload flagを立てず、可能なら現在のsessionで再実行する。boot予算超過はMod不具合としてCodexへ渡さず、即座に停止してevidenceを返す。
