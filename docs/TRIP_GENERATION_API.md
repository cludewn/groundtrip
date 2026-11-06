# 旅程生成API（POST /api/trips/generate）

Issue #6の実装。共通データモデルとAPI契約（`docs/DOMAIN_CONTRACTS.md`）に従い、
Geminiで日帰り旅行（1日・1地域・3〜4地点）の旅程を**提案**として生成する。

## 入出力

- リクエスト: `GenerateTripRequest`（`Content-Type: application/json`、本文32KB以下）。
- 成功: HTTP 200、`{ status: 'proposed', trip }`。
- 失敗: 共通契約の`ProposalFailure`（`status`と`message`）。更新後の旅程は含まない。

| HTTP | `status`                                     | 意味                                                                   |
| ---- | -------------------------------------------- | ---------------------------------------------------------------------- |
| 200  | `proposed`                                   | 旅程の提案。承認・保存・確定ではない                                   |
| 422  | `no_candidates` / `insufficient_information` | 条件を満たす旅程を作れない／入力が足りない（AIの申告または検証不合格） |
| 502  | `external_service_error`                     | Geminiの呼び出し失敗（接続・権限・拒否・途中終了・空応答・未設定）     |
| 400  | `invalid_request`                            | 入力が契約に違反（`issues`に項目ごとの理由）                           |
| 413  | `payload_too_large`                          | 本文が32KBを超える                                                     |
| 415  | `unsupported_media_type`                     | `Content-Type`がJSONではない                                           |
| 500  | `internal_error`                             | 想定外の失敗、または応答が共通契約に違反                               |

400／413／415／500は共通契約の`GenerateTripResponse`ではなく、API層だけのエラー（`status`と`message`）。
クライアントの通信中断・生成中は、完了応答とは別の操作状態として扱う。

## 生成結果について守っていること

- Geminiの出力は信用せず、Zodで検証してから`Trip`に変換する。形式不正・契約違反は`no_candidates`。
- 固定予定は、AIが名前や時刻を変えても**入力どおり**（根拠を含む）に置き換え、過不足なく1回ずつ含める。
- 地点の時刻が重なる・時刻順でない旅程は採用しない（移動時間・営業時間の照合ではない）。
- AIが作った地点は未同定・未照合として返す（`placeId: null`、`evidence: []`）。
  Geminiの提案は、施設情報や移動時間の検証結果ではない。照合はPlaces・Routes連携（Issue #7）で行う。
- 学びの反映は、入力にある承認済みの学びだけを、存在する地点に対して記録する。
  反映の説明文が実際の内容と一致するかは検証できない（AIの記述のまま）。
- ID・版（`version: 0`）はサーバーが付与する。承認・保存はしない。
- 課金対象のGemini呼び出しは1リクエストにつき1回で、自動再試行しない。

## 設定

サーバー側の環境変数（`.env.example`参照）。認証はADCで、APIキーやトークンはクライアントへ渡さない。

| 変数                    | 既定               | 内容                            |
| ----------------------- | ------------------ | ------------------------------- |
| `GOOGLE_CLOUD_PROJECT`  | なし（必須）       | Vertex AIを利用するプロジェクト |
| `GOOGLE_CLOUD_LOCATION` | `global`           | Vertex AIのロケーション         |
| `GEMINI_MODEL`          | `gemini-3.5-flash` | モデル名（切り替え可能）        |

## 未実装・要判断

- 認証・レート制限は未実装（認証は#10）。公開環境へ載せる前に、課金を伴うこのAPIへの
  アクセス制限の方針を決める必要がある。
- Places・Routesによる照合は未実装（Issue #7）。
