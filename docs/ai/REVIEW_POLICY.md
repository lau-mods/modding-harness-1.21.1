# Review policy

実装はsubscription-authenticated Codex CLIのSol、code/visual reviewはsubscription-authenticated Claude Code CLIのOpus。直接APIやAPI keyを使用しない。Proで利用できる構成であり、既存のTeam等のclaude.ai subscriptionも受け入れる。

Claudeの `auth status` を最初に確認し、email/orgやtokenはartifactに保存しない。`-p --model opus --permission-mode dontAsk --permission-prompts none --output-format json --json-schema ...` を使う。plan modeは計画作成・委譲を促す追加指示を注入するため、実Opus reviewの指摘に基づきdontAskを採用した。Read/Glob/Grepだけのtool制限、restricted file access、safe mode、strictな空MCP config、hooks無効、session非保存でread-onlyを強制する。必須flagがない古いCLIでは安全性を緩めず停止する。

Claudeのcwdはcurated snapshot。source・spec・対象docsに限定し、`.git`、環境設定、credential、node_modules、worldを含めない。`--restricted` でfile toolの読み取り先もこのworking directoryへ制限する。許可tool自体にはwrite/execがなく、safe-modeでproject/plugin hooksも無効化する。CLIの制限はOS sandboxではないため、信頼できないClaude実装やmanaged policyのOS-level封じ込めはこの軽量harnessの範囲外。

[review.schema.json](../../harness/schemas/review.schema.json)に従う `structured_output` のみを受理する。自由文やmarkdown fenceからJSONを推測しない。CLIの成功exitでもis_error、無効schema、矛盾するpass/blockerは失敗。Codexへはfindings配列だけを渡し、review transcriptやClaudeの自由な指示を転送しない。

blocker/majorは修正・再検証・再レビュー必須。minorは現在の利益とconcept増加を比較して判断し、minor-only passが可能。将来用のabstractionや行数metricだけの指摘は禁止。

harness自体の独立reviewは `review-harness`。作成者が指摘を修正し、tests後に同commandで再レビューする。最大3回。証跡はharness-reviewの各timestamp directoryへ保存する。reviewerが実装を変更するloopは存在しない。
