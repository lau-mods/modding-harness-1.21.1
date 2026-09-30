# Harness architecture

Node >=20のES modulesと標準libraryを使う。外部dependencyはMC Pilotだけで、lockfileを固定する。agent framework、daemon、database、semantic memory、独自MCPはない。

| File | Responsibility |
| --- | --- |
| harness/cli.mjs | command dispatch、実processへの接続、run artifacts、develop lock |
| lib/workflow.mjs | boundedな状態遷移。real/dry-run/testで同じengine |
| lib/process.mjs | shellなしsubprocess、timeout/output制限、終了処理、OS別Gradle wrapper |
| lib/repository.mjs | config、git/file hash、artifact、単純な変更分類表 |
| lib/validate.mjs | spec、resource/JSON、self-test、Gradle、GameTest |
| lib/agents.mjs | subscription CLI、read-only snapshot、review schema検証 |
| lib/mc-pilot.mjs | 外部mct CLI、専用runtime、scenario batch、log/screenshot |
| lib/doctor.mjs | read-onlyな環境診断 |

Gradle build設定はupstreamから変更しない。POSIXはgradlew、Windowsはjavaから同じwrapper JARのmainを起動する。Windows npm版CodexのshimはNode entry pointへ解決し、Claudeはnative CLIを使う。promptはstdinで渡す。shell quotingに依存しない。

artifactは `.harness-artifacts/<command>/<run-id>/`。開始hash、既存変更一覧、candidate差分、validation summary、Gradle log、structured review、runtime log抜粋、E2E結果、必要画像、最終summaryを置く。自動commitはしない。raw authentication resultは保存せず、API key系環境変数をagent子processから除外する。artifactも外部共有前に確認する。

レビューsource snapshotは上限800 KB。上限超過時はscopeを絞り、巨大dumpを黙って送らない。spec prompt上限30,000文字、diff上限60,000文字で切り詰めを明示し、untracked filesもmanifestに列挙する。snapshot sourceは変更せずコピーし、process/log出力だけをredactする。画像reviewには承認済みvisual要件・関連ACの本文とリンクされたspec/referencesの資料、必要な画像のみを渡し、sourceは含めない。LLM間で会話履歴やgenerated outputを送り直さない。deterministic resultをAIの主観で上書きしない。

MC Pilot 0.16.0のschema/info/searchでcommandを検証した。CLIは別processとして呼び、内部moduleはimportしない。client instanceの標準game directory配置と公開listのlaunchArgsをadapterの一点で検査する。MC PilotはNeoForge serverを作成できないため、事前導入したNeoForge serverをJava argfileでharnessが起動する。どちらも専用artifact directory内に限定する。[E2E setup](../../tests/e2e/README.md)参照。

`develop --dry-run` は副作用をmockにした同じengineでcode指摘→修正→再レビュー→build→GameTest skip→1bootでbatch→visual指摘→修正→resource reload→再レビューまで進む。これは実agent/runtime試験とは区別して `simulated: true` を保存する。

`lib/coverage.mjs` はMarkdown Verification表とtest/scenarioの参照を逆引きし、起動前に全required ACへの割当を確認する。検証用Modの専用runnerは本体の外に置き、共通moduleを呼ぶ。本体は検証用Modをimportせず、Mod固有のID・AC・resource path・例外commandを持たない。共通self-testも特定Modや仕様記入例に依存させない。新しいagent frameworkやDSLは追加しない。

`setup-runtime` は公式installerでexact NeoForge21.1.252を導入し、MC Pilot固有のinstance metadata更新をadapter内で完結する。EULAは明示flagまたは専用eula.txtによる本人同意のみ。setup/developは共通lockを使用する。同じruntimeを使う検証用projectのrunnerもこのlockを取得する。runtime準備、GameTest、client bootsを別々に記録し、prepare/mockの結果を実機passに昇格しない。
