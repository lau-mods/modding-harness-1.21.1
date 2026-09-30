# Code quality and scope

Mod、harness、test、scenario、docsに同じ品質基準を適用する。最小line countではなく、最小concept countを優先し、重複する説明を避ける。目の前の機能を直接表現し、ModではMinecraft/NeoForge APIをそのまま使う。Codex実装とClaude reviewの両方で適用する。

- interface、abstract base class、factory、strategy、builder、wrapper、generic abstraction、cache、fallback、configuration/compatibility layerは現在の具体的な必要性がある場合だけ作る。
- 実装が1つのinterfaceはexternal boundaryでなければ原則不要。NeoForge APIを転送するだけのwrapperも不要。
- 1回使う単純な式をlocal variableやprivate methodへ移すだけの抽出を避ける。ただしdomain conceptや非自明な意味に名前を付ける抽出は有用。
- API contract上起こらない状態へのnull checkやdefensive check、意味のない `catch (Exception)`、黙って成功にするfallbackは追加しない。外部process/JSON/file境界の実際に起こる失敗は検査し、原因を保持する。
- 「念のため」「将来用」「拡張性」は設計理由にしない。現在の仕様や外部境界による利益を説明する。
- コメントは逐語的な動作説明ではなく非自明な理由・制約に使う。
- method/class lengthにhard thresholdを置かない。metricを満たすための分割をしない。

reviewでは変更file数やdiff行数をscopeの手掛かりとしてよいが、合否の数値基準にはしない。Non-goalsに触れる追加機能はscope違反。minorを消すためだけの抽象化も避ける。

ハーネス本体に特定Modの仕様・registry ID・生成ファイル名・期待値を埋め込まない。これらはprojectの仕様・source・scenarioに属する。検証用Modの専用処理は本体へimportせず、検証用project側から共通moduleを呼ぶ。共通self-testは独立した最小の合成入力で契約を検証する。
