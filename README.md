# Modding harness — Minecraft 1.21.1

Minecraft Java **1.21.1 / NeoForge / ModDevGradle / Java 21** 用の共通開発基盤です。Codex Solで実装し、Claude Opusで独立review、Gradle/GameTest/MC Pilotで段階的に検証します。新規作成も既存projectへの導入も、同じ **project-owned files + `.harness` Git submodule** になります。

## Architecture and ownership

```text
modding-harness-1.21.1/       system-repository/
├── cli.mjs                 ├── .harness/  ← このrepositoryのsubmodule
├── package{,-lock}.json     ├── src/
├── config.json             ├── spec/
├── lib/                    ├── tests/e2e/scenarios/
├── test/                   ├── build.gradle, settings.gradle
├── prompts/, schemas/      ├── gradle.properties, gradle/, gradlew{,.bat}
├── log-allowlist.json       ├── AGENTS.md
├── docs/                   └── その他project固有ファイル
└── template/
```

| Ownership | 内容 | 更新方法 |
| --- | --- | --- |
| runtime-owned | CLI、lib、self-tests、npm dependencies、config、prompts/schema、共通docs/agent policy、review・validation・Minecraft lifecycle | `.harness` のcommit pointerを明示更新 |
| template-owned | `template/` 内のGradle、MDK sample source/resources、draft spec、scenario例、AGENTS/README、ignore/attributes、CI、MDK license | harness側で将来の新規作成用に変更 |
| project-owned | materialize済みの上記ファイル、既存systemのsource/spec/Gradle/AGENTS、独自設定・resources | system側で独立して変更 |

`template/` は **createでだけ使用** します。生成後の同期・上書きは行いません。通常のdoctor/validate/develop/reviewには不要です。runtimeは生成経路を記録・分岐しません。harness rootは自身のmodule URL（`lib/paths.mjs`）から、project rootはCLI実行時のcwd、または `--project PATH` から決めます。project rootで実行してください。subdirectoryからの暗黙的な親探索はありません。

Node dependenciesはharness内の `package.json` / lockfileで管理し、system rootにnpm packageを追加しません。

## Prerequisites

- Git、64-bit JDK 21、Node.js 22 LTS、npm。harnessのengine範囲は>=20 <26。
- `develop`: ChatGPT subscriptionで認証したCodex CLIと、claude.ai subscriptionで認証したnative Claude Code（Opus）。API keyは使用しません。
- 実E2E: desktop/OpenGL環境、専用NeoForge/MC Pilot runtime。[E2E手順](docs/ai/E2E.md)を参照。

## 既存systemへの導入

既存systemのrootで実行します。source tree、履歴、tag、release、Gradle、spec、AGENTSをtemplate版に置き換える必要はありません。

```sh
git submodule add <harness-repository-url> .harness
# 利用するreleaseを選び、detached HEADで固定
git -C .harness checkout --detach <version-tag-or-commit>
npm --prefix .harness ci --ignore-scripts
node .harness/cli.mjs doctor
node .harness/cli.mjs validate --build
git add .gitmodules .harness
# 内容を確認してsystem側でcommit
```

`doctor` は不足を具体的に報告します。project contractは `AGENTS.md`、`spec/PROJECT.md`、`build.gradle`、`settings.gradle`、`gradle.properties`、Gradle wrapper一式です。Gradle metadataには `minecraft_version=1.21.1`、`neo_version`、`mod_id`、`mod_version` が必要です。標準source/resource配置は `src/main/`、生成resourcesは `src/generated/resources/`、scenarioは `tests/e2e/scenarios/`。E2E配備JARは `build/libs/<mod_id>-<mod_version>.jar` を使用します。

`doctor` とcompile/build validationは `gradlew tasks --all` で `classes`、`test`、`build`、`runClient`、`runServer`、`runGameTestServer`、`runData` の存在を検査します。task一覧取得だけでMinecraftは起動しません。不足するtaskやmetadataは既存projectの設定に追加してください。harnessがGradleを上書きすることはありません。

`spec/PROJECT.md` の形式は [SPEC_WRITING](docs/ai/SPEC_WRITING.md)。既存 `AGENTS.md` には必要に応じ `.harness/docs/ai/AGENT_POLICY.md` への参照を追加できます。既存文書の置換は不要です。`develop` の実装agentには共通policyも明示します。artifactの `.harness-artifacts/` はsystem側の `.gitignore` に追加してください。

## 新規systemの作成

```sh
git clone <harness-repository-url> modding-harness-1.21.1
cd modding-harness-1.21.1
git checkout --detach <release-tag>
node cli.mjs create ../new-system
cd ../new-system
npm --prefix .harness ci --ignore-scripts
node .harness/cli.mjs doctor
node .harness/cli.mjs validate --build
git add .
git commit -m "chore: initialize system with modding harness"
```

`create` はGitとNode標準libraryだけで動作します。空directory（`.git` のみ存在する独立repositoryも可）をtargetにします。非空projectは拒否し、既存導入手順へ案内します。

1. harnessのremoteとrevisionを解決し、一時checkoutで取得します。
2. **そのrevisionの** `template/` をtargetへmaterializeします。directory名からGradleの `rootProject.name` を設定します。Mod ID等のMDK sample値とdraft specは保持し、ユーザー仕様確定時に変更します。
3. 必要なら `git init` します。既存の空Git repositoryの履歴・tag・remoteは保持します。
4. 同じrevisionのcheckoutを `.harness` としてGitにsubmodule登録し、`.gitmodules` とgitlinkをstageします。runtimeをsystem rootへ展開しません。
5. 完成後は通常のsystem + submoduleです。自動commit・npm install・Minecraft起動はしません。失敗時は生成途中のtargetを消さず、原因を報告します。

通常は現在のharnessの `origin` URLを使います。HEADを指すrelease tag（`v1.2.3` / `1.2.3`、複数ならversion降順）を優先し、なければHEADのSHAを使います。default生成は未commit変更を拒否します。remote側のtagと現在のcommitが異なる場合も拒否します。

必要な場合だけ明示overrideできます。

```sh
node cli.mjs create ../new-system --harness-ref v1.2.3
node cli.mjs create ../new-system --harness-url <repository-url> --harness-ref <full-commit-sha>
```

`--harness-ref` はexact tagまたは40桁SHAです。branch名は受理しません。選択revisionがremoteから取得可能で、現在の構造のtemplateを含む必要があります。URL overrideがなければorigin必須です。ローカルrepositoryのURLも使えますが、そのsystemを共有する場合は他の利用者からも取得可能なURLを指定してください。結果は常にdetached HEADとgitlink SHAで固定され、`main` 最新版へ自動追従しません。

## System repositoryのclone

```sh
git clone --recurse-submodules <system-repository>
cd <system-directory>
npm --prefix .harness ci --ignore-scripts
```

clone済みの場合:

```sh
git submodule update --init --recursive
npm --prefix .harness ci --ignore-scripts
```

## Harnessの更新

system rootで作業中の `.harness` の変更がないことを確認し、選んだtag/commitへ更新します。

```sh
git -C .harness status --short
git -C .harness fetch origin --tags
git -C .harness checkout --detach <version-tag-or-commit>
git -C .harness submodule update --init --recursive
npm --prefix .harness ci --ignore-scripts
node .harness/cli.mjs validate --build
git add .harness
git commit -m "chore: update modding harness"
```

更新単位はsystem側のsubmodule pointerです。systemごとに異なるversionを使えます。自動化も同じpointer更新で行えます。Gradle、source、spec、AGENTSを同期する処理はありません。

## CLI compatibility

system rootから `node .harness/cli.mjs <command>` で実行します。別cwdからは例として `node /path/to/.harness/cli.mjs validate --build --project /path/to/system` を使えます。

既存のnpm scriptsも利用できます。`npm --prefix .harness run doctor` / `run validate` / `run develop` はnpm起動元のdirectoryをproject rootにし、明示の `-- --project PATH` を優先します。

| Command | 内容 |
| --- | --- |
| `doctor` | Java/Node/Git/wrapper/tasks、project contract、agent CLI/auth、MC Pilot/runtime診断 |
| `validate --static` | project spec/JSON/resources/docリンク + runtime self-tests。Gradle/ゲームなし |
| `validate` | 上記 + Gradle task contract、classes/test |
| `validate --agent-fast` | static/resource + task contract、classes/test。self-testsは別ゲート |
| `validate --build` | static/self-tests + task contract、build |
| `develop --dry-run` | 同じ状態遷移engineのmock実行。AI/Gradle/Minecraftなし |
| `develop` | spec→実装/compile→review/fix→build→GameTest→batched E2E→visual |
| `setup-runtime [--accept-eula] [--players=N]` | 専用runtime準備。EULA同意は本人の明示操作のみ |
| `review-harness` | harness自身のstatic/self-testsとOpus独立review。project rootとは無関係 |
| `create TARGET [--harness-ref TAG_OR_SHA] [--harness-url URL]` | 新規systemのbootstrap |
| `npm --prefix .harness test` | runtime + bootstrap integration testsすべて |

既存command/optionの能力とgate順序は保持しています。entry pointは従来の `harness/cli.mjs` からrootの `cli.mjs` へ移動しました。通常runtime self-testsはtemplateを必要としないテストだけを実行し、bootstrap専用テストは `npm test` で実行します。

新規specは `Status: draft` のため実 `develop` を拒否します。仕様とAC/Non-goals/Verification割当を合意してからreadyにします。初回project commitも先に作成してください。

## Configuration, policies and artifacts

Runtime defaultsは [config.json](config.json): Sol/Opus、code review 3、client boot 3、visual cycle 2、GameTest auto。project固有identityはGradle/spec、操作/期待値はscenarioから読みます。project rootの `config.json` や `package.json` をharness設定として読みません。

runごとの明示overrideは `HARNESS_CODEX_MODEL`、`HARNESS_CLAUDE_MODEL`（Opus系のみ）、`HARNESS_CODE_REVIEWS`、`HARNESS_GAME_BOOTS`、`HARNESS_VISUAL_REVIEWS`（各1..10）、`HARNESS_GAME_TEST=required`（独自source set等）、`HARNESS_JAVA` です。重複したproject設定fileは追加しません。prepared runtime情報はproject側 `.harness-artifacts/e2e-runtime.json` に保存します。

[共通agent policy](docs/ai/AGENT_POLICY.md)、[workflow](docs/ai/DEVELOPMENT_WORKFLOW.md)、[testing](docs/ai/TESTING_POLICY.md)、[review](docs/ai/REVIEW_POLICY.md)、[architecture](docs/ai/HARNESS_ARCHITECTURE.md)を参照してください。system `AGENTS.md` は自由に拡張できます。Mod開発中はruntimeをread-onlyとし、必要なharness修正は別の保守作業として扱います。

証跡はproject側 `.harness-artifacts/<command>/<run>/`。review-harnessのみharness側に保存します。失敗はexit code 1、入力誤りは2です。worldやユーザー差分を自動削除しません。並行develop/setupはlockで拒否し、crash後は所有processの停止を確認して `develop.lock` のみ手動解除してください。

MDKのversionと4つのrun構成は維持しています。baselineは [upstream-baseline.json](docs/ai/upstream-baseline.json)、元文書は [UPSTREAM_README](docs/ai/UPSTREAM_README.md)。MDK licenseは `template/TEMPLATE_LICENSE.txt`、Mod配布licenseはsystem仕様で選択します。
