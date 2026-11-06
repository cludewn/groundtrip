# Places・Routes アダプター

Issue #7 のうち、外部APIとの接続部分。取得した事実を、共通の形で返す。名称の一致判定・営業時間の照合・
移動時間と固定予定の制約検証・根拠（`Evidence`）の組み立ては、照合処理の責務で、ここには含めない。

場所：`src/server/maps/`。サーバー側専用。認証はADC（サービスアカウント）のOAuthで、APIキーは使わない
（`GOOGLE_CLOUD_PROJECT`が必要）。接続の準備は最初の呼び出しまで遅らせ、未設定でもビルドは失敗しない。

```ts
const maps = createLazyMapsClient(process.env)
const found = await maps.searchPlaces({ query: '清水寺 京都', includeOpeningHours: true })
const route = await maps.computeRoute({ originPlaceId, destinationPlaceId, mode: 'WALK' })
```

## 戻り値と失敗の区別

「結果なし」と「呼び出しの失敗」を区別する。HTTP 200の空応答は失敗ではない。

| 状況                       | 戻り値・例外                          | 照合側での扱いの目安                            |
| -------------------------- | ------------------------------------- | ----------------------------------------------- |
| 候補あり（複数もそのまま） | `{ status: 'found', candidates }`     | 名称の一致を確認してから採用する（ゲート）      |
| 候補なし（HTTP 200・空）   | `{ status: 'no_candidates' }`         | 施設を同定できない → 「確認できない」           |
| 経路なし（HTTP 200・空）   | `{ status: 'no_route' }`              | 移動時間を確認できない（0分や到達可能にしない） |
| 呼び出しの失敗             | `MapsCallError`（`reason`、`status`） | API失敗として扱い、根拠を捏造しない             |

`reason`：`not_configured`／`invalid_request`／`unsupported_mode`／`auth_failed`／`timeout`／`network`／
`api_error`／`invalid_response`。例外にはクエリ・トークン・応答本文を含めない（`apiStatus`はGoogleの状態名のみ）。

営業時間は`openingHours`で、`not_requested`（要求していない）／`unavailable`（データなし）／
`available`（曜日0=日曜・時・分の期間）を区別する。データなしを「営業」とも「休み」とも解釈しない。
名称が取得できない施設は`name: ''`で返す（名称一致の対象にならない）。

## 費用・規約

- 呼び出しは1回だけで、自動再試行しない。タイムアウトは15秒。
- Placesの営業時間（`regularOpeningHours`、Enterprise）は、`includeOpeningHours: true`のときだけ要求する。
- 公共交通（`TRANSIT`）は対象外で、呼び出さずに`unsupported_mode`とする（理由は`API_CONNECTIVITY_FINDINGS.md`）。
- **保存してよいのはPlace IDだけ。** 名称・住所・座標・営業時間・所要時間は、処理中にのみ使い、DBやキャッシュへ保存しない。
- Googleマップ以外の画面にPlaces・Routes由来のデータを表示するときは、Googleの帰属表示が必要
  （詳細は`API_CONNECTIVITY_FINDINGS.md`§5）。この帰属表示は、UI側の対応事項。

## 含まないもの

HTTPのRoute Handler、利用者ごとの利用制限・認証、キャッシュ、照合・制約検証のロジック。
アダプターをHTTP経由で公開する場合は、課金を伴うため、認証と利用制限（#10）を先に入れる。
