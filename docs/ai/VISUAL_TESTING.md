# Visual testing

visual criteriaがあるscenarioだけ画像を撮る。MC Pilot query/Node assertでprocess alive、connected/in-world、期待GUI/state、関連error不在を先に確認する。local resource参照は直前candidateのvalidateで通過済みであること。画像を先に見てコードを推測修正するloopを作らない。

推奨fixture defaults:

| 項目 | 値 |
| --- | --- |
| window | 854×480、fullscreen=false |
| GUI scale | 2 |
| FOV | 70 |
| language | en_us（翻訳ACだけja_jp等） |
| seed | 1211 |
| location/player | overworld、0.5 80 0.5、fixtureで安全な床を準備 |
| yaw/pitch | 180 / 0 |
| time/weather | 6000 / clear、cycle停止 |
| render distance | 8 |
| resource packs | vanilla + Mod + harnessのloose resource packのみ |

専用clientのoptions.txtにはharnessが上記window/GUI/FOV/language/render distanceとpackを設定する。server seedは初期setupで設定し、scenarioがworld条件とscreen.size/GUI状態をassertする。MC PilotにはMCT_CLIENT_LANGUAGE=en_usを渡す。OS・GPU・fontの違いはevidenceへ記録し、pixel exact比較は契約が必要な時だけ使う。大量のglobal config knobは増やさず、例外はscenarioのsetup/criteriaに置く。

resource reloadは専用loose packへassetsを同期しF3+T、dataは専用datapackへ同期し `/reload`。packはharnessが初回起動前に作成・有効化する。所有markerのある生成assets/dataだけを置換し、user packやworldは削除しない。reload完了と期待stateはscenarioのcondition wait/assertで確認する。JARを書き換えただけで反映されたと仮定しない。削除・Java・registry・network・mod metadataはrestart。所有markerのない同名packがあれば引き取らず失敗する。

各scenario開始時にserver/client logのbyte offsetを記録する。MC Pilotにはserver logs-markがあるが、NeoForge serverを管理対象にできないためこのadapterはbyte offsetを使う。新しいwindowだけ走査しerror/exception/fatal/resource load失敗を抽出する。allowlistは [log-allowlist.json](../../harness/log-allowlist.json) のexact messageと理由のみ。広いregexでwarning/errorを隠さない。

Opusは必要な画像とACだけを見る。missing texture/model、magenta/black、UV、z-fighting、transparency、GUI clipping/overlap、text overflow、slot位置、item/block向き、placeholderをfeature固有基準に照らして検査する。visualが不要な仕様に装飾的なscreenshot reviewを追加しない。

MC Pilot0.16のmanaged launcherは854×480のwindowを使います。GUI scale2、OSのDPIによるframebuffer sizeは各PNGとMC Pilot queryに記録します。window sizeとframebuffer sizeは同一とは限りません。clientのWebSocket portはpublic `client launch --ws-port` により毎session空きportを選び、macOSの即時再bind失敗を避けます。
