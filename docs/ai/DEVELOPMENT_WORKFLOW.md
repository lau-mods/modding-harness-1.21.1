# 開発の検証順序

`develop` はPROJECT.mdの仕様コンパイル、Opusによる計画review、milestoneごとの候補検証、Harness所有のcommit、最終全体regressionを実行します。PROJECT.mdは実装agentに対して常に読み取り専用です。

1. HarnessがPROJECT.mdの準備とハッシュを確認します。Codexが派生モデルとWork Planを提案し、決定的な検査とOpusの独立reviewを通します。
2. Codex Solが現在のmilestoneだけを実装し、同じsession内で `validate --agent-fast` を成功させます。
3. Harnessがstatic/resource、ACの参照形式、self-testsを確認します。この段階でscenario moduleは実行しません。
4. Claude Opusが隔離snapshotを読み取り専用でreviewします。修正時は指摘と関連範囲だけをCodexへ渡し、再検証します。
5. Gradle buildと必要なNeoForge GameTestを実行します。
6. review済みscenarioを読み込んで、必要なE2E、保存再起動、マルチプレイをbatch実行します。
7. visual要件があれば実画像をOpusへ渡します。
8. 修正時は静的検証・review・build・必要なruntime検証を繰り返します。resourceだけなら安全な場合にreloadし、Javaやregistry等は再起動します。
9. 指紋とGit treeを照合した候補だけHarnessがローカルcommitします。最後にPROJECT.md全体のregressionを行います。

既定の候補・review回数、起動回数、画像review回数には有限予算があります。失敗、予算超過、runtime不足はevidenceに記録して停止します。GameTestのserver起動はclient boot数へ含めません。実装agentはMinecraft lifecycleを起動しません。

`--dry-run` は模擬engineの検査であり、実agent・Gradle・Minecraftの成功を意味しません。実機結果と区別して保存します。仕様変更では古いrunを継続せず、PROJECT.mdから派生モデルと残りのmilestoneを再生成します。ユーザー差分、world、過去evidenceを自動削除しません。
