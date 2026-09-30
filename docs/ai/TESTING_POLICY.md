# Testing layers

| Layer | 対象 | 実行 |
| --- | --- | --- |
| 1 | ゲーム不要のpure Java/domain logic | Gradle test。必要になった時だけJUnit等を追加 |
| 2 | compile/resource/build、harness | validate、Gradle classes/test/build、Node built-in test |
| 3 | block/entity/server/world挙動 | runGameTestServer |
| 4 | 実clientのGUI/input/統合挙動 | MC PilotのNode scenarioをbatch実行 |
| 5 | feature-specific visual AC | deterministic checks後のClaude Opus |

JSONや数式の検証をE2Eへ持ち込まない。低コスト層で検出できるものを先に処理する。新しいテストframeworkは利益がある場合だけ追加する。既存MDKのGameTest runとnamespaceを維持する。

fresh templateにはGameTestがない。autoでは `src/main/java` の `@GameTest` / `@GameTestGenerator`（fully qualifiedも可）を探し、なければ起動せずnot-applicableとする。コメントは除外する。テストはNeoForge 1.21.1のGameTestHolderまたはRegisterGameTestsEventで登録し、main source setに置く。独自source setや外部登録を使う場合だけ `gameTest: required` にし、Gradle側のbindingも設定する。detectorはJava compilerではないため、文字列内の注釈例などは誤検出しうる。

公式資料: [NeoForge 1.21.1 Game Tests](https://docs.neoforged.net/docs/1.21.1/misc/gametest/)。template `.nbt` は1.21.1の `data/<namespace>/structure`。テストが実際に登録され、対象namespaceと一致することをreviewする。

local resource validationはmodelsのparent/textureとblockstatesのmodel参照を確認する。`minecraft`、外部namespace、`#textureVariable`、registry IDはmissing fileと誤認しない。main/generated resourceを対象とし、完全なMinecraft resource compilerを再実装しない。runtime resource errorsは別途logとvisualで確認する。

pure logicの変更は `.../logic/...java` または `src/test/` に置けばcompile/unitに分類される。この分類にMinecraft依存を隠さない。他のJavaは保守的にworld/serverとして扱う。GameTest stageは分類のgameTestがtrueの変更にだけ適用する。screen/renderer/client Java、registry/network/metadataはrestart。dataのうちrecipe/loot_table/tags/advancementだけreloadを許可し、worldgenなど他のdataや未知のsrc変更はrestart。稼働中sessionでpure logicのclassが変われば再起動、test/scenario/docsだけならsessionを再利用する。分類は [repository.mjs](../../lib/repository.mjs) の短い表で管理する。

## Qualification evidence

実機qualificationでは、runtime version、各検証層の結果、実際の起動回数、独立review結果を `.harness-artifacts/qualification/<run>/` に記録する。割当済みのAC、mockやdry-runの成功は実機での成功と区別する。失敗runも保持し、再実行の結果で上書きしない。

検証用Mod固有の機能・AC・操作手順はそのModの仕様とscenarioに置き、ハーネスの共通方針には含めない。evidenceはgitignore対象なのでclone後は必要なfixtureとruntimeを用意して再生成する。実機検証の対応範囲は記録されたOS・runtimeに限り、他OSのself-testsを実機E2Eの証拠にしない。
