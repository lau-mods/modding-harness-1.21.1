# MC Pilot E2E

各 `scenarios/*.scenario.mjs` は普通のNode moduleで、default exportに `id`、`acceptanceCriteria`（PROJECTのAC ID）、`visual`、`setup`、`actions`、`assertions`、`screenshots`、`cleanup` を持ちます。[smoke.example.mjs](scenarios/smoke.example.mjs)は有効scenarioではありません。コピーして実際のACと挙動に書き換えてください。独自DSLやscenarioごとのbootは使いません。

`{mct}` を受け取る関数はCLI引数の配列を渡し、返されたdataをNode assertで検査します。state条件待機を使い、固定sleepを重ねないでください。screenshotsの各pointには `id`、`criteria`、`prepare`、`assertState` が必要です。setupが途中で失敗してもcleanupを実行します。通常cleanupは作ったtest block/item/GUI状態だけを戻し、worldを消しません。

## Runtime preparation

全環境はrepositoryの `.harness-artifacts/` 以下へ隔離します。instance内部の手動編集は不要です。

```text
npm ci --ignore-scripts
node harness/cli.mjs setup-runtime
# EULAを読み同意する場合だけ、本人が実行:
node harness/cli.mjs setup-runtime --accept-eula
node harness/cli.mjs doctor
```

`setup-runtime` はMinecraftを起動せず、MC Pilot instance、公式NeoForge **21.1.252** client/server、loopback限定server.properties、offline HarnessBotのOP、runtime設定を準備します。stock21.1.235は起動せずexact loaderへ更新します。Mod JARはbuild/review後のsession開始時に両側へ配備します。EULA未同意なら準備結果を残して停止し、上記の明示操作後に再開します。既存worldを削除しません。

MC Pilot0.16.0のv0.9.1 client mod URLは現在404のため、公式v0.14.0の1.21.1 NeoForge JARを公開SHA-256で固定しています。MC Pilot固有のcache/instance layout操作はadapterに限定しています。変更時は実qualificationで再検証してください。

**Node22 LTSを使用してください。** Node26の組み込みfetchとMC Pilotのundici7 dispatcherはmetadataを正しくdecodeできません。Node自体のglobal設定変更は不要です。Apple SiliconではNodeとJava21のarchitectureをarm64で揃えます。`HARNESS_JAVA` でJava実行ファイルを指定できます。setupはJavaをglobal installしません。

専用client optionsは854×480、GUI scale2、en_us、FOV70、render distance8を使用します。world条件は [VISUAL_TESTING](../../docs/ai/VISUAL_TESTING.md)に沿ってscenarioが固定します。安全なresource reloadには専用loose packを使い、所有markerのあるassets/dataだけを置換します。

専用clientの `config/fml.toml` はsetup時とsession起動前に `earlyWindowControl = false` を設定します。FML 4.0.44はGLFW初期化に成功しても1秒を超えるとERRORを出すため、[公式の回避方法](https://neoforged.net/meta/displayerrors/)で早期スプラッシュ表示を無効化します。既存の他の設定は保持します。早期表示のGL機能に依存するModの検証には、この設定の再検討が必要です。

`## Verification` のAC割当は起動前に逆方向も検証します。`phase: 'after-restart'` のscenarioは通常batchを保存終了した後、次のsessionで実行します。persistence検証ではsetupで対象を再作成しないでください。

## Multiplayer

`node harness/cli.mjs setup-runtime --players=2` で、異なるoffline usernameと専用game directoryを持つ2clientを準備します。省略時は1clientです。既存worldを維持し、全clientへ同じMod JARを配備します。接続先は共通のローカルNeoForge serverです。

setupを再実行すると、準備済みの人数設定を置き換えます。EULA同意時も `setup-runtime --accept-eula --players=2` のように人数を指定してください。人数を減らしても既存clientのdirectoryやworldは削除しません。

scenarioに `players: 2` と `verification: ['multiplayer']` を指定します。multiplayerのVerification割当には2人以上が必要です。関数へ渡す `clients` は宣言した台数の配列で、各要素は実player名の `name` と、そのclientだけを操作する `mct(args)` を持ちます。既存の `{mct}` は先頭clientを操作します。

```js
async actions({ clients }) {
  const [actor, observer] = clients;
  await actor.mct(['gui', 'close']);
  await observer.mct(['gui', 'close']);
}
```

assertionsでは仕様に沿って、操作側・観測側の両方の状態を確認します。同時操作が必要なら `Promise.all` を使います。serverへ1人が接続できるだけの確認は `e2e` として扱います。

screenshot pointの `client: 1` は2人目を撮影します（0始まり、省略時0）。そのpointの `prepare` / `assertState` の `{mct}` も撮影対象を操作します。画像artifactにはclientとplayer名を記録します。

batch全体で必要な最大台数を起動し、全scenarioの間接続を維持します。追加clientはscenarioごとに起動しません。全clientのreadinessとlogを検査し、resource reloadは全client、data reloadはserverへ1回実行します。終了処理は途中で失敗しても残りのclientとserverを停止します。

`gameBoots` はclient起動数です。既定値2では2人のbatchを1session実行でき、2人でrestart/persistenceや修正確認を行うには4以上が必要です。必要数を起動前に予算へ計上し、部分起動の失敗でも返却しません。summaryの `sessions` はserver起動試行数です。修正中に必要人数が増えた場合は停止し、runtimeと予算を確認して新しいrunを開始します。

MC PilotにはNeoForge server createがないため、harnessは上記専用serverをJavaで起動し、client操作はMC Pilotだけを使います。1回の起動で全scenarioを実行し、finallyで所有するprocessを停止します。clientから接続できるserver addressはliteralな127.0.0.1のみです。scenarioは信頼されたrepository codeなので、Node自体の任意コード実行能力をsandboxするものではありません。reviewでネットワーク操作やlifecycleの迂回を拒否してください。

このfresh templateにMod固有の受け入れ条件はありません。MC Pilot CLI/schemaの確認、mockによる状態遷移検証と、実際のMinecraft smokeは別の証拠です。同じNeoForge runtimeや表示環境がない場合、doctorの不足を解決するまでclientを起動しません。

MC Pilot0.16のmanaged launcherは854×480のwindowを使います。GUI scale2、OSのDPIによるframebuffer sizeは各PNGとMC Pilot queryに記録します。window sizeとframebuffer sizeは同一とは限りません。clientのWebSocket portはpublic `client launch --ws-port` により毎session空きportを選び、macOSの即時再bind失敗を避けます。
