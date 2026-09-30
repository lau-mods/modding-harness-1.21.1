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

`## Verification` のAC割当は起動前に逆方向も検証します。`phase: 'after-restart'` のscenarioは通常batchを保存終了した後、2回目のsessionで実行します。persistence検証ではsetupで対象を再作成しないでください。multiplayerを検証するscenarioには `verification: ['multiplayer']` を記載し、実際に専用serverとの同期（仕様に複数playerがあれば全player）をassertします。

MC PilotにはNeoForge server createがないため、harnessは上記専用serverをJavaで起動し、client操作はMC Pilotだけを使います。1回の起動で全scenarioを実行し、finallyで所有するprocessを停止します。clientから接続できるserver addressはliteralな127.0.0.1のみです。scenarioは信頼されたrepository codeなので、Node自体の任意コード実行能力をsandboxするものではありません。reviewでネットワーク操作やlifecycleの迂回を拒否してください。

このfresh templateにMod固有の受け入れ条件はありません。MC Pilot CLI/schemaの確認、mockによる状態遷移検証と、実際のMinecraft smokeは別の証拠です。同じNeoForge runtimeや表示環境がない場合、doctorの不足を解決するまでclientを起動しません。

MC Pilot0.16のmanaged launcherは854×480のwindowを使います。GUI scale2、OSのDPIによるframebuffer sizeは各PNGとMC Pilot queryに記録します。window sizeとframebuffer sizeは同一とは限りません。clientのWebSocket portはpublic `client launch --ws-port` により毎session空きportを選び、macOSの即時再bind失敗を避けます。
