# MC Pilot E2E

各 `scenarios/*.scenario.mjs` は普通のNode moduleで、default exportに `id`、`acceptanceCriteria`（PROJECTのAC ID）、`visual`、`setup`、`actions`、`assertions`、`screenshots`、`cleanup` を持ちます。[smoke.example.mjs](scenarios/smoke.example.mjs)は有効scenarioではありません。コピーして実際のACと挙動に書き換えてください。独自DSLやscenarioごとのbootは使いません。

`{mct}` を受け取る関数はCLI引数の配列を渡し、返されたdataをNode assertで検査します。state条件待機を使い、固定sleepを重ねないでください。screenshotsの各pointには `id`、`criteria`、`prepare`、`assertState` が必要です。setupが途中で失敗してもcleanupを実行します。通常cleanupは作ったtest block/item/GUI状態だけを戻し、worldを消しません。

## Runtime preparation

全環境はこのrepositoryの `.harness-artifacts/` 以下へ隔離します。Minecraft EULAは利用者自身が読んで同意する必要があります。harnessは自動同意しません。以下は人が初期setupで行う手順です。developがglobal installや既存worldの削除を行うことはありません。

1. `npm ci --ignore-scripts`。global MC Pilotは不要です。`MCT_HOME` を絶対path `<repo>/.harness-artifacts/mct-home`、`MCT_SKILL_TARGETS=none` に設定したterminalで、`node node_modules/@kzheart_/mc-pilot/bin/mct schema`、`info`、`client search --loader neoforge --version 1.21.1`、`server search --version 1.21.1` を確認します。PowerShellは `$env:MCT_HOME=...`、POSIXは `export MCT_HOME=...`。
2. `mct client create mcmod-test-1211 --loader neoforge --version 1.21.1 --account HarnessBot --mute`（mctは上記Node入口の省略）。**0.16.0のstock loaderは21.1.235で、このMDK21.1.252の必要versionより古い**ため、そのままではpreflightが拒否します。対応するMC Pilot版/runtimeが必要です。手動で公式NeoForge installerのclient installを使う場合は、create結果のruntimeRootDirへ同じ21.1.252をinstallし、専用instance.jsonの `launchArgs` の `--version-id` を作成されたversion IDへ変更します。元ファイルをbackupし、他のruntime/game-dir引数を変えないでください。MC Pilotの非公開moduleをimportして更新しません。
3. [公式NeoForge](https://projects.neoforged.net/neoforged/neoforge)の同じ21.1.252 installerを取得し、`java -jar <installer.jar> --installServer <repo>/.harness-artifacts/server`。生成された `libraries/net/neoforged/neoforge/21.1.252/{unix,win}_args.txt` を使用します。EULAに同意する場合だけserver/eula.txtを `eula=true` にします。
4. 専用server/server.propertiesに少なくとも次を設定します。`ops.json`にはoffline HarnessBotのUUIDを使いOPを与えます。UUIDは `OfflinePlayer:HarnessBot` のJava nameUUIDFromBytes（MD5/version3）です。外部接続は不要です。

```properties
server-ip=127.0.0.1
server-port=25575
online-mode=false
level-name=world
level-seed=1211
gamemode=creative
difficulty=peaceful
view-distance=8
enable-rcon=false
```

5. `.harness-artifacts/e2e-runtime.json` を作成します。

```json
{"client":"mcmod-test-1211","address":"127.0.0.1:25575"}
```

6. [VISUAL_TESTING](../../docs/ai/VISUAL_TESTING.md)のworld条件をscenarioに記述します。専用clientのwindow/optionsと `minecraft/resourcepacks/harness-resources`、専用serverの `world/datapacks/harness-data` はharnessが作成・同期します。これらの名前をuser packに使用しないでください。1.21.1のresource pack format34 / data pack48を使用します（[公式1.21 technical changes](https://www.minecraft.net/pt-pt/article/minecraft-java-edition-1-21)）。生成markerのあるpack内のassets/data以外は削除しません。
7. doctorとvalidate、code review、build、GameTestを通過してからdevelopがserver/clientを起動します。稼働中のclientは引き取らず、portが使用中なら停止します。Mod JARは専用mods/harness-under-test.jarに配備します。他のMod/worldは削除しません。

MC PilotにはNeoForge server createがないため、harnessは上記専用serverをJavaで起動し、client操作はMC Pilotだけを使います。1回の起動で全scenarioを実行し、finallyで所有するprocessを停止します。clientから接続できるserver addressはliteralな127.0.0.1のみです。scenarioは信頼されたrepository codeなので、Node自体の任意コード実行能力をsandboxするものではありません。reviewでネットワーク操作やlifecycleの迂回を拒否してください。

このfresh templateにMod固有の受け入れ条件はありません。MC Pilot CLI/schemaの確認、mockによる状態遷移検証と、実際のMinecraft smokeは別の証拠です。同じNeoForge runtimeや表示環境がない場合、doctorの不足を解決するまでclientを起動しません。
