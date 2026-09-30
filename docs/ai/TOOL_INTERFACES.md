# Verified tool interfaces (2026-09-30)

Codex `exec --help`、`login status`、local model catalogで確認したsubscription CLIのSolは `gpt-6-sol`。defaultに設定した。[公式code generation](https://developers.openai.com/api/docs/guides/code-generation)にもこのIDがある。[API側のGPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)はより新しいが、この環境のsubscription CLI catalogにはなかったため自動選択しない。利用可能になったらconfig/envで明示変更できる。利用権限はaccountによって異なり、doctorは有料のモデル呼び出しを行わない。

Claude Code 2.1.285の `--help` と [公式CLI reference](https://code.claude.com/docs/en/cli-reference)でheadless print、Opus alias、dontAsk、permission-prompts none、structured JSON、safe-mode、restricted、tool restrictionを確認。auth statusは通常権限でclaude.ai subscription、sandboxではkeychain制限により未認証となった。doctorはraw認証情報を保存しない。auth statusがloggedInでも実リクエストでOAuth期限切れとなる場合があり、その場合は利用者が再ログインする。

[MC Pilot](https://github.com/kzheart/mc-pilot) 0.16.0をproject-localに固定し、実際のschema/info/client search/server searchを取得した。NeoForge 1.21.1 clientはsupported/verified、stock loaderは21.1.235。server searchはvanilla/paper/purpur/spigotでNeoForgeは含まれない。MDKの必要loader21.1.252を勝手に下げない。CLI flagを推測して `--neoforge-version` を追加しない。新しいMC Pilotへ更新する時はschema/searchとadapter testsを再実行する。

CLI入口は `node node_modules/@kzheart_/mc-pilot/bin/mct`。JSONはCLIの `{success,data}` と、操作によってその中にあるWebSocketの `{success,data}` をそれぞれ検査する。`client list`、`client launch NAME --server 127.0.0.1:PORT`、`client wait-ready NAME`、`client stop NAME` を使用。schemaに `server logs-mark` は存在するが、このテンプレートの外部NeoForge serverには使えないためbyte offsetを使用する。

Node20全般がharnessの対象。MC Pilotの間接dependency `commander` / `undici` はNode20の後期patchを必要とするので、実用上Node22 LTS以上を推奨する。npm ciのengine warningを無視しない。MC Pilotのpostinstallによるglobal skill同期を避けるため `--ignore-scripts` を使う。
