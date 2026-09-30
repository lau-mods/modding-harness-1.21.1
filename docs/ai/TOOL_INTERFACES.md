# Verified tool interfaces (2026-09-30)

Codex `exec --help`、`login status`、local model catalogで確認したsubscription CLIのSolは `gpt-6-sol`。defaultに設定した。[公式code generation](https://developers.openai.com/api/docs/guides/code-generation)にもこのIDがある。[API側のGPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)はより新しいが、この環境のsubscription CLI catalogにはなかったため自動選択しない。利用可能になったらconfig/envで明示変更できる。利用権限はaccountによって異なり、doctorは有料のモデル呼び出しを行わない。

Claude Code 2.1.285の `--help` と [公式CLI reference](https://code.claude.com/docs/en/cli-reference)でheadless print、Opus alias、dontAsk、permission-prompts none、structured JSON、safe-mode、restricted、tool restrictionを確認。auth statusは通常権限でclaude.ai subscription、sandboxではkeychain制限により未認証となった。doctorはraw認証情報を保存しない。auth statusがloggedInでも実リクエストでOAuth期限切れとなる場合があり、その場合は利用者が再ログインする。

[MC Pilot](https://github.com/kzheart/mc-pilot) 0.16.0をproject-localに固定し、実際のschema/info/client search/server searchを取得した。NeoForge 1.21.1 clientはsupported/verified、stock loaderは21.1.235。server searchはvanilla/paper/purpur/spigotでNeoForgeは含まれない。MDKの必要loader21.1.252を勝手に下げない。CLI flagを推測して `--neoforge-version` を追加しない。新しいMC Pilotへ更新する時はschema/searchとadapter testsを再実行する。

CLI入口は `node node_modules/@kzheart_/mc-pilot/bin/mct`。JSONはCLIの `{success,data}` と、操作によってその中にあるWebSocketの `{success,data}` をそれぞれ検査する。`client list`、`client launch NAME --server 127.0.0.1:PORT`、`client wait-ready NAME`、`client stop NAME` を使用。schemaに `server logs-mark` は存在するが、このテンプレートの外部NeoForge serverには使えないためbyte offsetを使用する。

Node20全般がharnessの対象。MC Pilotの間接dependency `commander` / `undici` はNode20の後期patchを必要とするので、実機setupにはNode22 LTSを使用する。Node26 + MC Pilotのundici7 dispatcherではfetchのresponse headersが欠落し、圧縮metadataをJSONとして解釈して失敗した。npm ciのengine warningを無視しない。MC Pilotのpostinstallによるglobal skill同期を避けるため `--ignore-scripts` を使う。


`setup-runtime` は公式NeoForge21.1.252 installerの `--install-client` / `--install-server` を実際の `--help` で確認して使う。MC Pilot0.16.0が指すv0.9.1 client mod assetは404なので、[公式v0.14.0 release](https://github.com/kzheart/mc-pilot/releases/tag/v0.14.0)のNeoForge1.21.1 JARを公開SHA-256で固定した。adapterがcacheへ配置し、client createの後、公式installerのversion JSONとserver argfileの両方を検証してinstanceのversion-idを更新する。公開CLIにないloader指定flagを仮定しない。

macOS arm64のMC Pilot launcherではJavaもarm64の21を使う。`HARNESS_JAVA` はsetup時のJava executable overrideで、そのpathを専用instanceとserver runtime設定へ保存する。global Java/Node installationを変更しない。

上記release tagはv0.14.0だが、配布JAR内の `META-INF/neoforge.mods.toml` が宣言するmct Mod versionは**0.9.1**。CLI version0.16.0・release tag・JAR内versionは別に記録する。取得したbinaryのSHA-256は `d89bd309af94c0afe6b37dc03f8e9a689b4dabf95ff53f3f04fc7df9a7587788`。

NeoForge21.1.252 installerも[公式SHA-256](https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.252/neoforge-21.1.252-installer.jar.sha256)の `d0345e2a104ce4633065f572310ba6e0dd428bb6a73364cf0c2443ed9f8950ad` に固定し、再利用するcacheも照合する。
