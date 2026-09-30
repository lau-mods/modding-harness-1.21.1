# Project specification

Status: draft

この文書はMod全体の仕様と開発範囲の正本です。

仕様策定時は、実装方法ではなくプレイヤーから観測できる振る舞いを優先して記述してください。
未解決の製品判断が残っている間は `Status: draft` とし、開発開始時に `Status: ready` へ変更します。

---

## Identity

Mod ID: <FILL_MOD_ID>

表示名: <FILL_DISPLAY_NAME>

パッケージ: <FILL_PACKAGE_BASE_PATH>

対象: Minecraft Java 1.21.1 / NeoForge / Java 21。

言語・配布ライセンス: <FILL_LANGUAGES_AND_LICENSE>

---

## Purpose

誰に、どのようなプレイ体験を提供するModかを記述します。

<FILL_PROJECT_PURPOSE>

---

## Design principles

このMod全体で維持する仕様上の原則を記述します。

- <FILL_PRINCIPLE>
- <FILL_PRINCIPLE>

例:

- Vanillaの操作体系から大きく外れない。
- 自動化より手動操作を中心とする。
- プレイヤーへ隠れた複雑な状態を持たせない。

実装pattern、class構成、将来拡張のためのarchitectureは記述しません。

---

## Feature catalog

Modをプレイヤーから見た機能単位に分割します。

| Feature | Name | Summary | Depends on | Detail |
| --- | --- | --- | --- | --- |
| F-001 | <FILL_NAME> | <FILL_SUMMARY> | none | inline |
| F-002 | <FILL_NAME> | <FILL_SUMMARY> | F-001 | `features/F-002-<name>.md` |

Feature IDは一度割り当てたら変更しません。

小さい機能はこの文書だけで記述します。
複雑な機能だけ `features/` に詳細文書を作成します。

---

## Player experience

プレイヤーがModを利用するときの代表的な流れを、実装構造ではなく操作順に記述します。

### Primary flow

1. <FILL_INITIAL_PLAYER_STATE>
2. <FILL_PLAYER_ACTION>
3. <FILL_GAME_RESPONSE>
4. <FILL_PLAYER_ACTION>
5. <FILL_FINAL_RESULT>

### Important alternate flows

- <FILL_ALTERNATE_FLOW>
- <FILL_FAILURE_OR_BOUNDARY_FLOW>

---

## Functional requirements

### F-001 <FILL_FEATURE_NAME>

目的:

<FILL_FEATURE_PURPOSE>

開始状態:

<FILL_INITIAL_STATE>

操作:

<FILL_ACTIONS>

結果:

<FILL_OBSERVABLE_RESULTS>

境界条件:

- <FILL_EDGE_CASE>
- <FILL_EDGE_CASE>

### F-002 <FILL_FEATURE_NAME>

<FILL_OR_LINK_TO_FEATURE_SPEC>

必要なFeatureごとに同じ形式で追加します。

---

## Implementation sequence

これはclassやmethodの作成順ではなく、**機能を完成させる順序**です。

各段階は可能な限り単独で検証可能なvertical sliceとします。

| Step | Features | Goal | Depends on | Completion condition |
| --- | --- | --- | --- | --- |
| 1 | F-001 | <FILL_GOAL> | none | <FILL_OBSERVABLE_COMPLETION> |
| 2 | F-002 | <FILL_GOAL> | F-001 | <FILL_OBSERVABLE_COMPLETION> |
| 3 | F-003 | <FILL_GOAL> | F-001, F-002 | <FILL_OBSERVABLE_COMPLETION> |

実装担当は原則としてこの順序に従います。

ただし、同一step内のJava class、resource、testの作成順は実装担当へ委ねます。

---

## Acceptance criteria

すべてのrequired behaviorに一意なACを割り当てます。

Featureとの対応が分かるIDを推奨します。

- AC-F001-001: <FILL_INITIAL_STATE> のとき <FILL_ACTION> を行うと <FILL_OBSERVABLE_RESULT> になる。
- AC-F001-002: <FILL_BOUNDARY_CONDITION> のとき <FILL_OBSERVABLE_RESULT> になる。
- AC-F002-001: <FILL_ACCEPTANCE_CRITERION>

「正常に動作する」「適切に表示される」だけでは合否を判定できないため使用しません。

---

## Visual requirements

視覚的な要件を、対象FeatureまたはACと関連付けて記述します。

### V-001

対象: <FILL_FEATURE_OR_AC>

<FILL_VISUAL_REQUIREMENT>

確認条件:

- 視点: <FILL_VIEWPOINT>
- GUI状態: <FILL_GUI_STATE>
- 比較対象: <FILL_REFERENCE_OR_NONE>

### Common visual failures

以下は仕様に明記がなくても不具合として扱います。

- missing texture
- missing model
- 意図しない透明部分
- 明らかなUV崩れ
- GUI要素の重なり
- 文字切れ
- 意図しないZ-fighting

視覚要件が存在しない場合は、その理由を記述します。

---

## Persistence

保存する状態:

<FILL_PERSISTED_STATE>

保存単位:

<FILL_SCOPE_OF_PERSISTENCE>

以下について期待する挙動を記述します。

- world save
- server restart
- client reconnect
- block/entity破壊
- dimension移動
- 既存worldへの導入

不要な項目は理由を記述します。

---

## Multiplayer

<FILL_MULTIPLAYER: 対応範囲、状態の確定側、同期、同時操作、権限、導入が必要な側>

複数player固有の挙動がない場合も、その旨を明記します。

---

## Compatibility

必須依存:

<FILL_DEPENDENCIES_OR_NONE>

対応する追加環境:

<FILL_SUPPORTED_COMBINATIONS>

明示的に対象外とする環境:

<FILL_UNSUPPORTED_COMBINATIONS>

---

## Non-goals

今回実装しない機能・範囲: <FILL_NON_GOALS>

---

## Reference assets

| ID | Resource | Purpose | What to reference | What not to copy |
| --- | --- | --- | --- | --- |
| REF-001 | <FILL_PATH_OR_URL> | <FILL_PURPOSE> | <FILL_FEATURES_TO_REFERENCE> | <FILL_EXCLUSIONS> |

参考資料がない場合は「なし」と記述します。

---

## Unresolved questions

- <FILL_QUESTION>

実装結果に影響する未解決事項のみ記載します。

`Status: ready` にする前にすべて解決します。

未解決事項がない場合:

なし。

---

## Verification

すべてのAcceptance Criterionに少なくとも1つの検証方法を割り当てます。

Evidenceは実装担当が作成するtest/resource path、scenario ID、またはscenario ID/screenshot IDです。

| AC | Method | Evidence |
| --- | --- | --- |
| AC-F001-001 | <unit/static/gametest/e2e/visual/multiplayer/persistence> | <FILL_EVIDENCE> |
| AC-F001-002 | <FILL_METHOD> | <FILL_EVIDENCE> |
| AC-F002-001 | <FILL_METHOD> | <FILL_EVIDENCE> |

同じACへ複数の検証方法を割り当てても構いません。

---

## Change policy

この仕様が `Status: ready` になった後、観測可能な挙動を変更または追加する場合は、コードより先に仕様を更新します。

以下は仕様変更を必要とします。

- 新しいplayer-facing feature
- 新しいblock、item、entity、GUI等の追加
- 既存操作の結果変更
- persistenceの変更
- multiplayer behaviorの変更
- visual requirementの変更
- compatibility範囲の変更

以下は原則として仕様変更を必要としません。

- observable behaviorを変えないbug fix
- refactoring
- naming改善
- test implementationだけの変更
- build/tooling修正

機能追加時は以下の順序に従います。

1. Feature IDを割り当てる。
2. Feature catalogを更新する。
3. Functional requirementsまたはfeature specを追加する。
4. 必要ならImplementation sequenceを更新する。
5. ACを追加または変更する。
6. Verificationを割り当てる。
7. Non-goalsとの矛盾を確認する。
8. 仕様差分を確定する。
9. その後に実装する。
