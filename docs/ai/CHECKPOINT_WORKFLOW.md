# Checkpoint / milestone development

`develop --task` は既存の単一候補 `developWorkflow` の外側で、Plan → milestoneごとの実装・検証・commit → final regressionを管理する。既存の `develop` は自動commitしない単一開発単位として残る。小さいtaskもWork Planを持ち、1 milestoneでよい。

## Task and CLI

[bootstrap](../../README.md#新規systemの作成) でsystem + `.harness` submoduleを作る。既存systemも同じモデルを使う。ユーザーが `spec/PROJECT.md` の恒久仕様/Verification表を確定し、今回の仕事を `spec/tasks/TASK-001.md` に書く。

```markdown
## Goal
PROJECTで合意したblockの設置と描画を完成させる。
## Included Acceptance Criteria
- AC-BLOCK-PLACE
- AC-BLOCK-VISUAL
## Constraints
既存versionと互換性を維持する。
## Non-goals
加工処理、GUI、将来用network abstractionは追加しない。
```

AC行は `- AC-ID` だけを書く。taskはPROJECTに存在するACのsubsetであり、ACを発明・弱化しない。実装agentは `spec/**` を編集できない。ユーザーがTask/仕様を先にcommitする。初回project commit、Git author設定、cleanなworktree/indexが開始条件。

```sh
node .harness/cli.mjs develop --task spec/tasks/TASK-001.md --plan-only
node .harness/cli.mjs develop --resume
# 計画から一括実行
node .harness/cli.mjs develop --task spec/tasks/TASK-001.md
# M03のcommit直後に停止
node .harness/cli.mjs develop --task spec/tasks/TASK-001.md --stop-after M03
# AI/Gradle/Minecraft/commitなし
node .harness/cli.mjs develop --task spec/tasks/TASK-001.md --dry-run
```

`--task` はproject相対の `spec/tasks/<name>.md`。`--project PATH` も使える。`--resume` と `--task` は同時指定しない。dry-runは1 milestoneの模擬Planと既存mock engineを使い、`simulated: true` を記録する。実証拠ではなく、実runへresumeできない。

## Plan and current context

Codexがread-onlyでPlanを提案し、[schema](../../schemas/work-plan.schema.json)と決定的validatorで検証する。余分なfield、重複/欠落AC、未知の検証参照、後方/循環dependency、identity/hash不一致を拒否する。taskの各ACをちょうど1 milestoneへ割り当てる。各sliceはgoal、excludedScope、検証参照、短いcommit subjectを持つ。1..100 milestones、依存先は先行milestoneのみ。

Opusが隔離snapshotでPlanをreviewする。horizontal infrastructureだけの段階、動作未完成のslice、過大/過小分割、将来専用の抽象化、cross-feature regression不足は拒否する。Plan失敗はfindingを残して停止する。reviewerはPlanを編集しない。

実装promptは現在のgoal、AC本文、excludedScope、constraints/non-goals、関連仕様と直近findingを中心にする。後続milestoneや会話履歴を再送しない。code reviewには現在のmilestone開始HEADからのdiffと変更fileを渡す。完了状態はGit commitで表す。

長大taskの例（ACはPROJECTで事前定義する）:

| Milestone | 完成する挙動 | 証拠 |
| --- | --- | --- |
| M01 | blockを登録・設置・描画できる | placement E2E + visual |
| M02 | 加工を1回完了できる | unit/GameTest + processing E2E |
| M03 | 再起動後も加工状態を保持する | after-restart persistence |
| M04 | GUIから開始/停止できる | GUI E2E + visual |
| M05 | 他playerから同じ状態を観測できる | multiplayer E2E |

M01のexcludedScopeにはprocessing、persistence、GUI、networkを記す。共通基盤だけを先に作らない。全milestone後には必ず全体regressionを行う。

## Verification and Git ownership

各milestoneは既存pipelineを通る: 実装session内compile/unit → harness static/resource/self-tests → 独立code review → build → applicable GameTest → E2E → applicable visual review → lifecycle停止 → fingerprint照合 → commit。仕様requiredと変更分類が要求する検証の和集合を使い、required検証を変更分類だけでskipしない。

途中では未着手task ACの証拠fileを要求しない。今回・完了済み・task外の既存ACについてcoverageを検査する。pre-review validationはscenarioをimportせず参照形式と静的証拠だけを調べる。review済みcandidateのbuild後にscenarioをloadし、厳密な参照検査と実行を行う。scenarioはreview対象の信頼済みNode codeであり、sandboxされたpluginではない。

E2Eはmilestone指定/仕様required + smoke + change-affected regression。scenarioには任意で `alwaysRun: true` と `affectedPaths: ['src/main/java/example']` を指定できる。affectedPathsはproject相対のfile/directory prefixでglobではない。未指定scenarioはruntime変更時に保守的に全部実行する。visual変更ではvisual scenarioが必要。`phase: 'after-restart'`、`players`、boot予算の既存動作を維持する。`verification.fullRegression: true` でも全scenarioを選択する。

最終regressionは実装agentを呼ばず、compile/unit、build、applicable GameTest、全scenario（multiplayer/persistenceを含む）、必要画像のOpus reviewを行う。失敗時に修正loopへ入らず停止する。

fingerprintはGit列挙のsource/resources/tests/scenarios/build設定、file mode、全submoduleのgitlink/HEAD/worktree、index、および `build/libs/<mod_id>-<mod_version>.jar` のSHA-256を含む。ignored source/test入力（生成resourceの `.cache` を除く）は拒否する。buildによるreview済みsource変更も再reviewが必要。最終build後のfingerprintを各stage後・commit直前に照合する。

検証時の生file hashに加え、Gitがattributes/EOL/filter適用後に保存するcanonical blob IDもfingerprintへ含める。stage後の全index blob/modeをそれと照合し、WindowsのCRLFを扱いながら検証後の変換設定変更も拒否する。commit後にはGit tree、親、messageを照合する。Git filterは既存projectの信頼する設定を使う。並行編集しないこと。

commitはHarnessだけが行う。agentのfilesystem profileではGit metadata/spec/runtimeをread-only、networkを無効にする。全agent実行前後とstage境界でHEADを確認する。history変更時は即停止し、自動復元しない。Git wrapperにはstage/commitと読み取りだけを実装し、push/remote更新/reset/rebase/checkout/stash/mergeの操作は存在しない。checkpoint commitではhooksとGPG signingを無効化し、既存設定を変更しない。これはHarnessによるGit操作の保証であり、任意Node/Gradle codeのOS sandboxではない。

Harnessはreview済みPlanのsubjectにrun/milestone/AC/verificationの短いtrailerを加える。巨大なartifactや会話をcommitしない。harness repository自体の保守commit/pushは自動化しない。

## State, resume and recovery

```text
.harness-artifacts/checkpoints/
├── latest.json
└── <run-id>/
    ├── state.json
    ├── plan-1/plan.json, review/
    ├── M01/attempt-1/
    ├── M02/attempt-1/
    ├── final-regression-1/
    └── failure-*.json, failure-*.patch
```

stateはtemporary fileからrenameで置換する。latestは最後に開始した実runを指し、dry-runは上書きしない。各milestoneと明示resumeごとに既存の有限retry budgetを使う。失敗attemptや過去Planを保持する。

resumeはbase commit、完了commitの親chain、expected HEAD、spec全体/task/Plan hash、harness revision/worktree、project worktree/index/JARを照合する。不一致を新baselineとして採用しない。通常の失敗/interrupt後は保存した未commit candidateから当該milestoneを再検証する。kill/crashによる未記録の編集も自動採用しない。人間が保存状態を復旧するか、新task runとして扱う。

commit前にcandidate/tree/messageをpending intentとして永続化する。commit後state保存前に中断しても、親/tree/message/fingerprintが一致する直後のcommitだけをresumeで確認する。HEADが旧commitのままなら同じverified candidateをcommitする。他のcommitをcheckpointへ勝手に採用しない。

```sh
node .harness/cli.mjs develop --resume
node .harness/cli.mjs develop --resume --replan --plan-only
node .harness/cli.mjs develop --resume
```

replanはcleanなcheckpoint境界だけで行い、完了milestoneの内容と順序を固定する。残りについてschema/AC coverage/Opus reviewを再実行する。未commit candidateがあれば先にそのmilestoneを完了する。spec/task自体の変更は新task runとなる。

M02失敗時はM01 commitとM02未commit差分を保持する。failureは完了milestone、失敗stage、evidence、diffと推奨人間操作を記録する。final regressionのsource修正は、既存checkpointを保持したままユーザーが新しいfix taskを作成・commitし、新taskのfix milestoneとfinal full regressionで扱う。過去runは失敗証拠として残す。transientな環境障害なら変更のない状態でresumeし、final regressionを再実行できる。

既存のexclusive develop/setup-runtime lockを共有し、crash後に自動奪取しない。所有processの停止を確認してlockだけを手動解除する。worldや履歴は削除しない。
