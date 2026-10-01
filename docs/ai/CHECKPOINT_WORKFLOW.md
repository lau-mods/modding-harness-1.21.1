# 検証済みcheckpoint開発

通常は `spec/PROJECT.md` を完成させ、project rootで次を実行します。

```sh
node .harness/cli.mjs develop
```

HarnessはPROJECT.mdの準備を確認し、Codex Solに読み取り専用で派生project modelを作らせます。モデルには機能、要件、AC、検証割当、制約、非対象範囲、参照情報、依存関係、原文引用、PROJECTのSHA-256を記録します。決定的な検査とClaude Opusの独立reviewを通してからWork Planを確定します。開発者によるTASKやAC表の作成は不要です。

```sh
node .harness/cli.mjs develop --plan-only
node .harness/cli.mjs develop --resume
node .harness/cli.mjs develop --dry-run
node .harness/cli.mjs develop --stop-after M03
node .harness/cli.mjs develop --resume --replan --plan-only
```

`--plan-only` は実装せず計画とreviewまで行います。`--dry-run` はPROJECT.mdから模擬モデルと1件のmilestoneを作り、外部AI・Gradle・Minecraft・commitを実行しません。模擬結果は `simulated: true` と記録し、実機の証拠にはしません。`--stop-after` は指定の検証済みcommit直後に停止します。

Work Planはschemaと決定的validatorで、重複・欠落AC、検証参照、前方依存、identity/hash、完了milestoneの不変性を調べます。各milestoneは観測できる完成状態を作り、goal、AC、依存、対象外範囲、検証、commit subjectを持ちます。技術基盤だけの段階はOpusが拒否します。小さなprojectは1件でよく、長いprojectは検証可能な縦の機能単位へ分割します。

各milestoneは、Codex実装と同session内のcompile/unit → Harness static/resource/self-tests → Opus code review → Gradle build → 必要なGameTest → E2E → 必要な画像review → 指紋照合 → Harness所有のローカルcommitを通ります。必要なGameTest/E2E/visualは変更分類だけで省略しません。scenarioはreview前に実行せず、review後に読み込みます。保存は再起動後に、マルチプレイは複数clientで検証します。

実装promptには現在の目標、関連AC、PROJECT原文の関連引用、制約、非対象範囲、直近の失敗要約だけを渡します。過去の会話や全派生文書を毎回送信しません。完了した作業の長期状態はGitにあります。失敗したmilestoneは差分とevidenceを保持し、resume時は修正作業として再開します。

`state.json` は `.harness-artifacts/checkpoints/<run-id>/` にatomic保存します。resumeはHEAD、完了commit chain、PROJECT/model/Planのハッシュ、Harness revision、worktree/index/JARの指紋を照合し、不一致を新baselineとして採用しません。PROJECT.mdが変わった場合、単純なresumeは古い計画を拒否します。`--resume --replan` は新しい仕様のrunを作り、前モデルからIDを引き継ぎ、未完了の作業を再計画します。未commitの候補差分が残る場合は自動破棄せず停止します。

完了済みmilestoneのcommitは変更しません。新しい仕様で修正が必要なら新しいmilestoneを作ります。全milestone後はPROJECT.md全体を対象とするcompile/unit、build、適用可能なGameTest、全scenario、必要なvisual reviewを再実行します。失敗しても過去のcheckpointは保持します。

Git操作はHarnessのstage/commit/readだけです。検証したsource、index、JAR、Git tree/parent/messageを照合し、agentによるGit変更を拒否します。remote操作とpush実装はありません。Harness自体の保守では自動commitしません。
