# NeoForge AI Mod development template

Minecraft Java Edition **1.21.1 / NeoForge / ModDevGradle / Java 21**の開発テンプレートです。`spec/PROJECT.md` に具体的な仕様を書き、Codex Solで実装、Claude Opusで独立review、Gradle/GameTest/MC Pilotで段階的に検証します。元のMDKのJava source、build設定、4つのrun構成は維持しています。

## Prerequisites

- 64-bit JDK 21、Git、Node.js 22 LTS（harness自体は>=20。MC PilotのNode26互換問題はE2E手順参照）、npm。
- ChatGPT subscriptionで認証したCodex CLI。
- Claude Pro等のsubscriptionで認証したnative Claude Code。Opusと現在のheadless/structured/safe-mode flagsを使えること。
- E2Eにはdesktop/OpenGL、MC Pilotと同じNeoForge versionの専用client/server、Minecraft EULAへの同意が必要です。

## Initial setup

clone後、このdirectoryをIDEへ開きます。IntelliJ IDEA/Eclipseなどの通常のMDK開発も可能です。

```text
npm ci --ignore-scripts
codex login
codex login status
claude auth login
claude auth status
node harness/cli.mjs doctor
node harness/cli.mjs validate --build
node harness/cli.mjs develop --dry-run
```

認証は各CLIのブラウザflowで行います。API keyをrepositoryへ置かず、harnessがglobal設定を書き換えることもありません。sandboxからkeychainが読めない場合、doctorが未認証と表示することがあります。通常のローカルterminalで再確認してください。

MC Pilotは唯一のNode devDependencyで0.16.0に固定しています。`--ignore-scripts` はglobal skill install/syncを避けるためです。server/client初期setupと現在のloader制約は [tests/e2e/README](tests/e2e/README.md) を参照してください。doctorは不足を報告し、installやMinecraft起動は行いません。

## Write specifications and develop

[spec/README](spec/README.md)と[記入欄](spec/PROJECT.template.md)に沿って [spec/PROJECT.md](spec/PROJECT.md) を編集します。目的、機能、AC、visual、保存、multiplayer、compatibility、**Non-goals**、参考資料を具体化し、`Status: ready` にします。未記入では実developは拒否します。

```text
node harness/cli.mjs develop
```

CodexはspecのMod IDに合わせMDK sampleを更新し、機能と必要なtest/scenarioを実装します。レビューはClaudeがread-onlyで行い、指摘はstructured findingsとしてCodexへ返します。client lifecycleはharnessだけが管理します。普通のIDE runは人間によるdebug用として引き続き利用できます。

## Commands and validation

| Command | 内容 |
| --- | --- |
| `doctor` | Java/Node/wrapper/Git/agent CLI/auth/MC Pilot/required files/runtimeの診断 |
| `validate --static` | spec/JSON/resource/doc整合性 + harness self-tests。ゲーム・Gradleなし |
| `validate` | 上記 + Gradle classes/test |
| `validate --build` | 上記 + Gradle build |
| `review-harness` | static検証後、実Claude Opusによる独立read-only review |
| `develop --dry-run` | 同じ状態遷移engineのmock実行。外部AI・Gradle・Minecraft起動なし |
| `develop` | spec→実装→静的検証→compile/test→review/fix→build→GameTest→必要なE2E→visual |
| `setup-runtime [--accept-eula]` | exact NeoForge client/server準備。ゲームは起動せず、EULAは本人の明示操作のみ |
| `npm test` | Node built-in runnerによるharness self-tests |

表のcommandは `node harness/cli.mjs <command>` で実行します。GameTestがないfresh templateではnot-applicableにします。低コスト検証を先に完了し、完成候補だけをMinecraftへ持ち込みます。defaultはcode candidate/review3回、client boot2回、runtime/visual batch2回。resource-only修正は安全なloose pack reload、Java/registry/networking変更はrestartします。

詳細は [workflow](docs/ai/DEVELOPMENT_WORKFLOW.md)、[testing](docs/ai/TESTING_POLICY.md)、[visual](docs/ai/VISUAL_TESTING.md)、[code quality](docs/ai/CODE_QUALITY.md)、[review policy](docs/ai/REVIEW_POLICY.md)、[architecture](docs/ai/HARNESS_ARCHITECTURE.md)。常時すべてをagentへ読ませる必要はありません。

## Artifacts and recovery

`.harness-artifacts/` はgitignoreされています。runごとに開始状態、changed files/diff、validation、agent command/process evidence、review JSON、関連log抜粋、E2E/画像、summaryを保存します。巨大latest.logや会話履歴を次のagentへ渡しません。

失敗はexit code 1で停止し、summary/failure.jsonに原因が残ります。予算超過を自動resetして再試行しません。根拠を読んでspec/code/runtimeを直し、明示的に新しいrunを開始してください。実行中の別developはlockで拒否します。強制終了後は所有processが停止していることを確認し、`.harness-artifacts/develop.lock` だけを手動で削除します。worldやユーザー差分を消す操作は行いません。認証不足ならCLI login、runtime不足ならE2E setupを完了してください。

## Models and configuration

[harness/config.json](harness/config.json)にimplementer `gpt-6-sol`、reviewer `opus`、有限budget、GameTest modeを保存しています。`HARNESS_CODEX_MODEL` / `HARNESS_CLAUDE_MODEL` でrun単位overrideもできます。reviewerはOpus系のみ受理します。Codex defaultはこの環境のsubscription CLIで確認した正式Sol IDで、APIの最新modelとCLI accountの利用可能modelは区別します。[確認済みinterface](docs/ai/TOOL_INTERFACES.md)参照。

configを巨大化させず、featureの見た目・テスト条件はspec/scenarioに置きます。独自source setでGameTestを登録するときは `gameTest: required` を使います。

## MDK and template updates

baseline SHA・remote・初期status・versions・構造は [upstream-baseline.json](docs/ai/upstream-baseline.json)。元MDK READMEも [UPSTREAM_README](docs/ai/UPSTREAM_README.md) に保存しました。upstream updateは別branchで差分をreviewし、ModDevGradle/NeoForge変更とharness変更を分けて取り込みます。baselineを上書きして初期情報を失わず、更新時のSHAを別記録へ追記してください。自動force push/resetは行いません。

標準 `client`、`server`、`gameTestServer`、`data` は保持しています。通常の `gradlew runData`、`runClient`、`runServer` は人間が必要時に使えます。build JARは `build/libs/`。IDEの依存解決問題は `gradlew --refresh-dependencies` を検討し、`clean` は生成build出力だけを再生成します。

Mojang mappingの利用条件は [NeoFormのlicense reference](https://github.com/NeoForged/NeoForm/blob/main/Mojang.md)を確認してください。MDK template licenseはTEMPLATE_LICENSE.txt、Modの配布licenseは自分の仕様で選択します。[NeoForge公式docs](https://docs.neoforged.net/docs/1.21.1/gettingstarted/)と[NeoForged Discord](https://discord.neoforged.net/)も利用できます。

## Harness and project boundary

ハーネスはユーザー仕様とscenarioを入力として、検証・review・Minecraft lifecycleを管理します。Mod固有のID、生成ファイル名、操作、期待値はprojectの仕様・source・resource・scenarioだけに置きます。検証用Modの専用runnerとテストもハーネス本体から分離し、それらがなくても共通self-testとdry-runを実行できます。実機qualificationの手順と結果は検証用projectとそのartifactsで管理します。
