# PROJECT.md 記入例

このファイルは参考例です。開発者が維持する仕様入力は [PROJECT.md](PROJECT.md) だけです。機能ID、AC ID、TASK、検証表、milestone表は書く必要がありません。

```markdown
# Project

Status: ready

Mod ID: examplemod

## Purpose

プレイヤーが金属を手動で板材へ加工できる。

## Features

### 銅のプレス機

プレイヤーが銅インゴットを1個入れて操作すると、銅の板材が1個できる。
材料がない場合は加工を開始せず、材料を消費しない。

## Visual Requirements

プレス機の上面に銅色の圧盤を表示し、設置後に上下が逆にならない。

## Persistence Requirements

加工中の状態はworld保存とserver再起動後も維持する。

## Multiplayer Requirements

serverが加工結果を確定し、同じ機械を見ている全playerに同じ結果を示す。

## Constraints

Minecraft Java 1.21.1 / NeoForge / Java 21を対象とする。

## Non-goals

hopperによる自動入出力は作らない。
```

観測できる動作を具体的に書き、量、境界条件、保存や複数playerでの期待結果を必要に応じて明記してください。重要な製品判断が未決定ならdraftのままにし、PROJECT.md内で解決してからreadyにします。
