# PROJECT.mdの書き方

開発者が維持する仕様入力はproject側の `spec/PROJECT.md` だけです。TASK、feature、reference、AC対応表、milestone、実装・review用briefはHarnessとAIが派生します。生成物の内容がPROJECT.mdと矛盾した場合はPROJECT.mdが優先されます。

`# Project`、`Mod ID: ...`、目的、機能または要件をMarkdownで記述します。新規templateのdraftとTEMPLATE_NOT_CONFIGUREDを消して、準備ができたら `Status: ready` にします。AC IDや専用DSLは不要です。英語のsection名は例であり、内容は自然な日本語で書けます。

```markdown
# Project

Status: ready

Mod ID: examplemod

## Purpose
プレイヤーが金属を手動で板材へ加工できる。

## Features

### 銅のプレス機
銅インゴット1個を入れて操作すると銅板が1個できる。
材料がない場合は加工されず、材料も減らない。

## Visual Requirements
設置したプレス機の圧盤が上面に見える。

## Persistence Requirements
加工中の状態はserver再起動後も保持する。

## Multiplayer Requirements
serverが結果を確定し、すべてのplayerに同じ状態を示す。

## Constraints
Minecraft Java 1.21.1 / NeoForge / Java 21。

## Non-goals
hopperによる自動化は行わない。
```

「初期状態、操作、観測できる結果」を具体的に書いてください。数、例外、満杯・空、保存、複数playerの同時操作、画像の視点と配置、互換性などは必要な場合に記述します。Java class、package構成、test file名、milestone境界は指定しなくて構いません。

AIはPROJECT.mdを先に分析し、機能、要件、AC、検証方法、依存、作業単位を生成します。各派生項目はPROJECT.mdの原文引用とハッシュに結び付き、Opusが意味の一致を独立に確認します。IDはHarness内で生成し、変更時に同じ要件のIDを可能な限り維持します。削除IDは退役させ、他の要件へ再利用しません。

実装方法の小さな曖昧さはagentが判断します。製品挙動を左右する重要な曖昧さは `NEEDS_PROJECT_CLARIFICATION` として箇所、理由、選択肢を報告します。開発者はPROJECT.mdを編集して答えます。TASKファイルへ答えを書く必要はありません。

PROJECT.mdを変えると古いモデルと未完了計画は実行できません。新しいrunでは前の派生モデルと比較し、追加・変更・削除を反映して残りの作業を計画します。完了済みcommitは書き換えません。引用元と検証割当は `.harness-artifacts/checkpoints/<run-id>/project-model.json` で確認できます。これらを削除してもPROJECT.mdとsourceから再生成できますが、過去のID対応を残すにはartifactの保持が有益です。
