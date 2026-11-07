# Firestore保存と本人データの保護（Issue #10）

ブラウザはFirebase匿名認証で取得したIDトークンを送る。各Route Handlerは既存の
`requireActor`でトークンと失効を検証する。Firestore Admin SDKは認証と同じAdmin Appを
サーバーで初期化する。Rulesはクライアントからの読み書きを全件拒否する。

## データ構造

| パス                                                | 保存用DTO                                                                                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users/{uid}/trips/{tripId}`                        | `{ ownerUid, trip }`。共通TripのID・版・日付・地域・タイムゾーン・希望・Stop・学びの適用情報を保存する。Stopは下記の保存対象に限定する。                                               |
| `users/{uid}/trips/{tripId}/revisions/{revisionId}` | `{ ownerUid, revision }`。対象Trip・版・Stop ID、理由、文脈、前後の保存用Stop、未承認状態を保存する。                                                                                  |
| `users/{uid}/learnings/{learningId}`                | 有効時は `{ ownerUid, state: 'approved', version, learning }`。撤回時は `{ ownerUid, state: 'revoked', id }`。撤回後は本文を消し、古い初回承認リクエストによる復活を防ぐためIDを残す。 |

UIDは検証済みActorから決める。関連Tripも本人のパスで参照し、取得したデータの
`ownerUid`を `requireOwner` で照合する。IDと文書キーも照合する。通常のIDはそのまま使い、
Unicodeやパスの区切り文字・予約名を含むIDは衝突しないキーに変換する。文書内とAPI上のIDは元の値を保つ。
APIで文書を指定するIDは256文字までとし、パスパラメーターではURLエンコードする。

共通Zodスキーマの項目を基に保存DTOを定義し、書き込み前に検証する。読み出し時は
DTOと復元後のドメインモデルを検証し、IDの重複・不正な時刻・不正な承認状態などを拒否する。
JSONエスケープで渡された孤立サロゲートは、ネストした文字列を含めてDB操作前に400で拒否する。

### Maps由来データ

- 旅程生成が本人入力またはGemini提案から作る `Stop.name` は、アプリの予定名兼検索名とする。
  Firestoreでは `planName` に保存し、読み出し時は `Stop.name` に戻す。照合失敗時も予定名と地域で再検索できる。
- サーバーのPlacesアダプターは取得名を `displayName` として返す。予定名とは別の一時データとして扱い、
  `Stop.name` や予定時刻・滞在時間に、取得名・営業時間・Routesの所要時間を転記しない。
  Google Maps由来の保存対象は再照会用のPlace IDのみ。HTTPで受け取るPlace IDは照合の証明に使わない。
  根拠の有無や出典も予定名の由来の判定に使わない。
- 根拠一式、住所・座標・営業時間・移動時間、Revisionの影響説明・制約判定は保存対象から外す。
  再取得時は `evidence: []` とし、Revisionの制約は `not_checked` を返す。
- Places表示名が必要になったときは、保存済みPlace IDをサーバーでPlace Details (New)へ渡し、
  `displayName` を取得して帰属を付けた一時表示に使う。IDが無効・不一致の場合は、元の予定名と地域で再検索する。
  今回の保存APIはMaps照会を行わず、後続の照合機能が再取得を担当する。
- 利用者の自由記述（予定名、Revisionの理由・報告、Learningの本文など）は保存する。手動転記や任意のHTTP入力の
  出所は文字列から証明できない。照合結果やMapsを使った生成処理を接続する際は、元の予定名を維持し、
  外部サービスの値をこれらの欄や生成の永続化対象に転記しない。
- 先行版の `name` 形式の文書は読み出せる。既にプレースホルダーに置換された元の名前は復元できない。

[Places APIのPlace ID保存条件](https://developers.google.com/maps/documentation/places/web-service/place-id) ·
[Google Maps Platformサービス別規約](https://cloud.google.com/maps-platform/terms/maps-service-terms) ·
[Place Details (New)](https://developers.google.com/maps/documentation/places/web-service/place-details)

## API

全操作に `Authorization: Bearer <Firebase ID token>` が必要。JSON本文のある操作には
`Content-Type: application/json` を指定する。本文上限は64 KiB。レスポンスは `Cache-Control: private, no-store`。
DTOの所有者・撤回マーカーはレスポンスに含めない。

| 操作                                                           | 入力                                                                                                                                                                    | 成功                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `POST /api/trips`                                              | 本人が保存を選んだ `Trip`。初版は `version: 0`、`learningApplications: []`。                                                                                            | 201 `{ trip }`                                                    |
| `GET /api/trips`                                               | なし                                                                                                                                                                    | 200 `{ trips }`                                                   |
| `GET /api/trips/{tripId}`                                      | なし                                                                                                                                                                    | 200 `{ trip }`                                                    |
| `PATCH /api/trips/{tripId}`                                    | `{ expectedVersion, preferences }`。希望条件のみ変更する。                                                                                                              | 200 `{ trip }`。版はサーバーで+1。                                |
| `POST /api/trips/{tripId}/revisions`                           | 同じTrip・現行版・現行Stopを参照する `Revision`。承認状態は `pending`。                                                                                                 | 201 `{ revision }`                                                |
| `GET /api/trips/{tripId}/revisions`                            | なし                                                                                                                                                                    | 200 `{ revisions }`                                               |
| `GET /api/trips/{tripId}/revisions/{revisionId}`               | なし                                                                                                                                                                    | 200 `{ revision }`                                                |
| `POST /api/learnings/{learningId}/approve`                     | `{ expectedVersion, sourceTripId, category, content, scope }`。本人が確認した内容（120文字以内）。初回の期待版は0、再承認は取得した版。地域限定時は元Tripの地域を使う。 | 200 `{ version, learning }`。承認状態・決定時刻はサーバーが設定。 |
| `GET /api/learnings`                                           | なし                                                                                                                                                                    | 200 `{ learnings: [{ version, learning }, ...] }`                 |
| `GET /api/learnings/{learningId}`                              | なし                                                                                                                                                                    | 200 `{ version, learning }`                                       |
| `DELETE /api/learnings/{learningId}?expectedVersion={version}` | 取得した版                                                                                                                                                              | 204                                                               |

失敗は `{ error: { code, message } }`。未認証・不正・期限切れ・失効は401。
所有者不一致・対象なしは同じ404 `not_found`。入力不正は400、本文超過は413、
Content-Type不正は415。期待版の不一致は409 `version_conflict`、IDの重複は409
`already_exists`、Revisionと現行Stopの不一致は409 `revision_mismatch`。
保存内容の破損は500 `invalid_stored_data`、DB障害は503 `storage_unavailable`、
認証基盤の障害は503 `auth_unavailable`。内部エラーの詳細はレスポンスに含めない。

## 版管理と承認

- Trip更新では、トランザクション内で現行版を読み、期待版と一致する場合のみ更新と版の加算を行う。
  同じ期待版で再送・並行更新した場合は一度だけ確定する。作成と候補保存は同じIDで再作成できない。
  応答を受け取れず確定の有無が分からない場合は、再取得して現在の状態を確認できる。
- Revision保存では、同じトランザクションでTripを確認し、現行版・変更前の保存用Stop・固定状態を照合する。
  保存済み候補は、後からTripの版が進んでも元の版を保持する。Tripの予定を変更する適用処理は
  #28の再検証と接続してから公開する。
- Learningの下書きは画面で扱う。編集・却下・入力不備では現行の承認済みレコードが残る。
  再承認では、元Tripの所有権と現行Learningの版・元Trip ID・分類をトランザクション内で確認し、同じIDの承認済み内容を一度に置き換える。
  撤回は別操作とし、現行版の一致を確認して行う。再度保存する場合は新しいIDを使う。

## 後続Issueとの接続

- **PR #27** の照合は元の `Stop.name` を維持し、候補の比較にはアダプターの `displayName` を使う。
  保存や再照会を接続するときも同じ境界を守る。
- **#9** は保存済みTripとRevisionを取得し、`baseTripVersion` と現行版を比較する。根拠や影響は再取得結果を表示する。
- **#28** は適用直前に、所有権・Trip版・対象ID・変更前Stop・固定予定を照合し、営業時間・移動・時刻の制約をサーバーで再検証する。
  取得や検証を終えた版と対象を適用トランザクション内で再照合し、対象Stopの置換、Trip版の加算、承認・適用の記録をまとめて確定する。
- **#12** は振り返り材料をクライアント申告から本人の保存済みTrip・適用履歴の参照へ切り替える。
  候補編集・却下は下書きの操作とし、承認ボタンを専用APIに接続する。撤回は独立した操作にする。
- **#13** は `getApplicableLearnings(new FirestoreLearningStore(), actor.uid, region)` を使い、本人の有効な承認済みLearningを取り出す。
  生成APIでは本文中のLearningを認可に使わず、サーバーで採用・反映先を確定する。反映済みTripの保存はその生成経路から接続する。
