# Gemini・Places・Routes 疎通確認の結果（Issue #3）

実施日：2026-11-05 ／ 対象プロジェクト：`project-a3d3ded4-c376-43a6-8b4` ／ 認証：ADC（OAuth）のみ。APIキーは作成していない。

> **追記（2026-11-07）**：上記プロジェクトは削除要求済み（課金無効）となり、以降は `groundtrip` プロジェクトを使う。同プロジェクトで`aiplatform`・`places`・`routes`を有効化し、Gemini（旅程生成API）とPlaces・Routes（アダプター）が、ADCのOAuthのみで動くことを再確認した（Placesの営業時間取得、存在しない名称の空応答、Routesの徒歩・車）。

> 本書は**疎通確認の実測記録**であり、設計の確定ではない。取得できた情報と、そこから保証できることを区別して書く。

## 1. 結論

**Gemini → Places → Routes の順に呼び、AI生成の旅程を「情報源と整合／矛盾あり／確認できない」に分類する流れは、実際のAPI応答で成立した。** ただし、次の制約を設計に織り込む必要がある。

| 検証対象            | 実測結果                                                                       | 保証できること                           | 保証できないこと                           |
| ------------------- | ------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------ |
| Gemini（Vertex AI） | 検証用の項目を持つJSONを `responseSchema` で生成できた                         | 出力が指定スキーマに従う形式であること   | 内容の正しさ。施設の実在・営業・価格       |
| Places（New）       | Place ID・名称・住所・座標・営業状態・曜日別の通常営業時間・価格帯を取得できた | 取得時点のGoogle上のデータとの突き合わせ | 臨時休業・特別営業・当日の混雑・予約可否   |
| Routes              | 徒歩・車は取得できた                                                           | 取得時点の推定移動時間・距離             | 渋滞や遅延。公共交通は**取得できなかった** |

## 2. 呼び出したAPIと結果

| API・メソッド                        | 主な指定                                                  | HTTP | 結果                                                                      |
| ------------------------------------ | --------------------------------------------------------- | ---- | ------------------------------------------------------------------------- |
| Vertex AI `generateContent`          | `gemini-3.5-flash`、location=`global`、`responseSchema`   | 200  | スキーマ通りのJSON。2回とも成功                                           |
| 同上                                 | `gemini-2.5-flash`、location=`global`                     | 404  | `NOT_FOUND`。モデル一覧には載っているが、このプロジェクトでは使えなかった |
| Places `places:searchText`           | 日本語クエリ、`locationBias` または `locationRestriction` | 200  | 正常。UTF-8で送った場合は期待した施設が返った                             |
| Routes `directions/v2:computeRoutes` | `DRIVE` / `WALK`（座標またはPlace ID）                    | 200  | 距離・所要時間を取得                                                      |
| 同上                                 | `TRANSIT`（座標・Place ID、出発時刻あり／なし）           | 200  | **4回すべて空（`{}`）。** 原因は未特定                                    |

## 3. 取得できた・できなかったフィールド

- **Places**：`id`、`displayName`、`formattedAddress`、`location`、`types`、`businessStatus`、`regularOpeningHours`（`periods` と `weekdayDescriptions`）、`priceLevel`、`priceRange`（店により有無あり）、`rating`。`regularOpeningHours` が無い店があり、その場合は「確認できない」にする。
- **Routes**：`distanceMeters`、`duration`、`staticDuration`、`legs.localizedValues`、`warnings`。公共交通の乗換情報（`transitDetails`）は、経路が返らないため確認できなかった。
- **Gemini**：`stopId`、`name`、`placeSearchQuery`、`category`、`areaHint`、`startTime`、`stayMinutes`、`isFixed`、`reason`。Placesで照合できる構造を持たせれば、後段で検証できた。

## 4. GroundTrip設計への示唆

1. **名称一致を判定のゲートにする。** 昼食の代替候補で、生成された店名が別の施設（飲食店→別の飲食店、飲食店→医院）に紐付いた。名称が一致しない場合は、営業時間の結果が「矛盾あり」に見えても**「確認できない」**とする。
2. **正規化して名称を比較する。** 「奥丹清水」と「奥丹 清水」のように、空白や表記ゆれで一致しないことがある。空白・記号を除いて比較し、候補が複数あるときは座標と住所も使う。
3. **「候補なし」「同名複数」「API失敗」を区別する。** 空応答は HTTP 200 で返る。HTTPステータスだけでは失敗を検出できない。
4. **営業時間は曜日で判定できる。** `periods` の `day` は 0=日曜。対象日の曜日で突き合わせる。これは**通常営業時間**の照合であり、臨時休業は判定できない。
5. **固定予定への到達性は、徒歩・車で判定できる。** Routes の所要時間と、前後の予定の余裕を比べる。
6. **公共交通は当面「確認できない」として扱う。** 徒歩・車のみで判定し、公共交通を使う案は「移動時間を確認できない」と表示する。Geminiの推定時間を根拠として埋めない。公式FAQの記述と実測の関係は§6を参照。
7. **Geminiのモデル名は設定で差し替え可能にする。** 一覧にあっても404になるモデルがあった。起動時または初回呼び出しで可用性を確認する。
8. **日本語クエリは UTF-8 で送る。** Windows の Git Bash の `curl -d` で日本語を直接渡すと UTF-8 にならず、無関係な結果が返る。HTTPクライアントを使う実装では問題にならないが、手元の検証では注意する。

## 5. 費用・規約の注意

- **Places API (New) のフィールドのSKU区分**（公式のデータフィールド一覧による。2026-11-07 確認）：
  - `regularOpeningHours` と `priceRange` は、いずれも **Enterprise**（Text Searchでも Enterprise）。
  - `displayName` と `businessStatus` は Pro、`formattedAddress` と `location` は Essentials、`id` は Essentials（IDs Only）。
  - 実際の単価・請求額は、本書では確定していない。実運用前に、公式の料金表とCloud Billingの請求内訳で確認する。
- 複数のフィールドを指定したときに、請求がどの区分で決まるかは、データフィールド一覧のページに説明が無く、**未確認**（以前の版にあった「最も高いSKUで決まる」は、公式の根拠を確認できていないため、確定事項としない）。安全側に、必要最小限のFieldMaskとし、`regularOpeningHours`（Enterprise）は、営業時間が必要なときだけ要求する（アダプターの既定は要求しない）。
- **保存・表示の条件**（Google Maps Platformの条件。設計書の不変条件 7 に従う）：
  - Place ID は、キャッシュ制限の例外で、**無期限に保存してよい**（Places・Routesのポリシーページ。確認済み）。
  - Place ID 以外（名称・住所・営業時間・所要時間など）のキャッシュ・保存の可否と期間は、利用規約（Service Specific Terms）が定める。**本文を確認できていない**（規約ページは、取得ツールでは本文を読めなかった）。検索結果の抜粋では、緯度経度は連続30日まで一時保存でき、その後は削除する、とされていた（二次情報・要原典確認）。**運用上は、Place ID だけを保存し、それ以外は処理中にのみ使う。**
  - Googleマップを使わずにPlaces・Routesのデータを画面に表示するときは、**Googleの帰属表示が必要**（Googleマップのロゴが望ましく、スペースが足りない場合のみテキスト「Google Maps」。コンテンツの上端または下端の近く、同じ視覚的なまとまりの中に置く。ポリシーページ。確認済み）。Googleマップ上に表示し、帰属がすでに見える場合は不要。旅程の路線図（Googleマップではない画面）に、Places由来の名称・営業時間等を出す場合は、この帰属表示が必要になる。
  - 請求先がEEAの場合は、別の規約が適用される。
  - アプリ側の利用規約・プライバシーポリシーの公開義務は、Places・Routesのポリシーページには記載が無かった。

## 6. 未解決事項

- Routes の `TRANSIT` が空になる原因。公式FAQ（Google Maps Platform FAQ「In which countries are transit directions available?」）に、「Routes APIは、Indian Railway Catering and Tourism Corporation と日本のものを除く、Google Transitパートナーに対応する」旨の記載がある（原文：`The Routes API supports all Google Transit partners, except the Indian Railway Catering and Tourism Corporation and those in Japan.`）。実測した`TRANSIT`の4回の空応答と整合する説明だが、**個々の空応答の原因や、日本国内のすべての公共交通経路の可否までは断定しない**（FAQは「サポート外」という語や`TRANSIT`への言及はしておらず、「日本のもの」が指す事業者の範囲も書かれていない）。方針は§4-6のとおり、当面「確認できない」とし、アダプターは`TRANSIT`を呼び出さない。
- 将来日時の営業時間（`regularOpeningHours` と `currentOpeningHours` の使い分け）。
- 交通状況を考慮した所要時間（`TRAFFIC_AWARE`）。
- 費用上限（予算アラート、クォータ）の設定。
- 本番で APIキー を使うか、サービスアカウント／ワークロードのOAuthを使うか。キー作成には `apikeys.googleapis.com` の有効化が必要で、本確認では実施していない。
