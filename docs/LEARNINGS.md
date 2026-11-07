# 振り返りと承認済みの学び（Issue #12・保存に依存しない部分）

旅行後の振り返りから「学び」の候補を作り、本人が編集・承認したものだけを、次回の旅程づくりへ渡す。
学びの保存はパーソナライズであり、Gemini自体の再学習ではない。共通契約は`docs/DOMAIN_CONTRACTS.md`の`Learning`。

## 構成

| 場所                                          | 責務                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/lib/learnings/lifecycle.ts`              | 編集・承認・却下・次回に渡せる学びの選択（純粋ロジック。画面とサーバーで共用） |
| `src/server/learnings/generate-candidates.ts` | 振り返りの材料から、Geminiで学びの候補（1〜3件）を作る                         |
| `src/server/learnings/store.ts`               | 承認済みの学びの保存先（インターフェースとメモリ実装）                         |
| `src/server/learnings/handler.ts` ほか        | `POST /api/learnings/candidates`（候補の作成だけ。承認・保存はしない）         |

## 守っていること

- 候補はすべて**未承認（pending）**で返す。AIは承認状態・ID・適用地域を決めない（地域は旅程の地域をサーバーが入れる）。
- 編集した学びは、承認済みでも**必ずpendingに戻し、再承認を求める**。
- 次回に渡せるのは、**承認済みで、適用範囲（全地域／同じ地域）が合うものだけ**。各要素を契約（`ApprovedLearning`）で形式を検証し直す。
- 保存できるのは**承認済みだけ**。利用者ごとに分離する。
- 情報源との不一致（`verification`）と、個人の好み（`preference`）を区別する。
- **模擬報告（デモ用の想定）は、実際に起きた出来事として学びにしない。** AIへの指示だけに頼らず、アプリケーション側で除外する。
  材料判定とプロンプト生成は、共通の`usableRevisions`（**承認済みで、模擬報告ではない変更**）だけを使い、模擬報告はAIへ渡さない。
  感想が無く、使える変更も無ければ、AIを呼ばず情報不足とする。
- 材料（感想か、使える変更）が無ければ、AIを呼ばず情報不足とする。未承認・却下の変更も、材料にしない。
- 感想・変更理由は、指示ではなくデータとしてAIに渡す。

## API：POST /api/learnings/candidates

- リクエスト：`{ trip, revisions, feedback }`（`revisions`は同じ旅程の変更履歴、`feedback`は1000文字以内、本文は64KB以下）。
- 成功：HTTP 200、`{ status: 'proposed', learnings }`（1〜3件、すべてpending）。
- 失敗：`no_candidates`／`insufficient_information`は422、`external_service_error`は502。API層のエラーは400／413／415／500／503（旅程生成APIと同じ）。
- **機能フラグ`LEARNING_CANDIDATES_ENABLED=true`のときだけ受け付ける（既定は無効、503）。** 課金を伴うため、認証・利用制限が入るまで停止しておく。
- Geminiの呼び出しは1リクエスト1回。再試行しない。

## 承認済みデータとの接続

#10の[保存API](FIRESTORE_PERSISTENCE.md)が、本人確認、元Tripの所有権、専用操作によるLearning承認と撤回を扱う。
保存済みの学びを再編集する間は、旧版を有効なまま保持する。専用APIで新版の承認が成功した時点で置き換わる。

候補生成APIの `revisions` は現在もクライアント申告。振り返りの接続では、本人の保存済みTripと
適用履歴をサーバーで取得する。現行の確認画面はローカル状態で承認・却下を扱うため、
専用の承認APIを接続する際に、承認済みの版と編集下書きを分けて扱う。

#13（次回の旅への学びの選択）の接続契約は次節に定める。

## 次回の旅への学びの接続契約（#13）

画面で見た内容と違う学びが、黙って生成に使われないようにする（Own the Why）。選択は内容ではなく、
**画面に表示したときの版**に紐づける。

| 場所                                                           | 責務                                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/features/learning-reuse/learning-reuse-picker.tsx`        | 本人の承認済みの学びを版つきで表示し、選択を `{ id, version }[]` で通知する              |
| `src/server/learning-reuse/selection.ts`                       | `resolveSelectedLearnings`。選択を本人の保存済みデータと照合して、採用する学びを確定する |
| `src/features/learning-reuse/learning-application-summary.tsx` | 生成後の適用記録（学びID・対象の予定・AIの説明）の表示                                   |

### 選択の契約

- 選択IDは `{ id, version }`（`LearningSelectionSchema`）。本文・承認状態・所有者は運ばない。
  `version` は `GET /api/learnings` が返す版（`VersionedLearning.version`）で、再承認のたびに加算される。
- サーバーは `resolveSelectedLearnings(store, ownerUid, region, selections)` で、版つきの一覧
  （`FirestoreLearningStore.listVersionedApproved`）を取得し直して照合する。`ownerUid` は検証済みActorのUIDだけを渡す。
  版を返せないストア実装は渡せない（型で拒否。返った値が版つきの承認済みでなければ実行時にも拒否する）。
- 版が現行と違えば、内容が同じでも `selection_changed` とする（再承認で内容が差し替わった可能性を区別できないため。
  保守側に倒す）。撤回後に同じIDで保存し直しても、過去に発行した版は再利用しない。
- 出力は、選択順の `ApprovedLearning[]`。本文は `MAX_LEARNING_CONTENT_LENGTH`（120文字）を再検証し、超える場合は採用しない。
  `ApprovedLearningSchema` は既存文書の読み取り互換のため上限を持たない。
- 空の選択は「学びを使わない」と解釈し、保存先を読まずに `[]` を返す。
- 地域は前後の空白を除いた**完全一致**（`normalizeLearningRegion`。画面とサーバーで同じ関数を使う）。
  全角・半角などの表記揺れの正規化は未決定（`DOMAIN_CONTRACTS.md`）のため、画面に「同じ表記の地域だけ」と明示する。

### エラーとHTTP状態

保存先の例外（破損文書による `invalid_stored_data`、`storage_unavailable` など）は、内部情報を含めず
`unavailable` に変換する。統合側には `LearningSelectionError` だけが届く。

| `LearningSelectionError.code` | HTTP | 起きるとき                                                            | 利用者への案内                             |
| ----------------------------- | ---- | --------------------------------------------------------------------- | ------------------------------------------ |
| `invalid_selection`           | 400  | 選択の形式が不正、重複ID、上限（40件）超過、所有者・地域が空          | 入力を見直す                               |
| `selection_changed`           | 409  | 版の不一致、撤回、他人のID、存在しないID、適用地域の不一致            | 最新の一覧を取得して、選び直す             |
| `unavailable`                 | 503  | 一覧を取得・検証できない（破損・障害・版なし）、本文が120文字を超える | 学びを使わずに旅程を作る、または時間をおく |

認証・失効は、これらより前に `requireActor` が401で扱う。

### 生成APIとの接続方針（統合PRで実施。このPRでは変更しない）

- 現行の `POST /api/trips/generate` の `GenerateTripRequestSchema` は `strictObject` で、選択IDを運ぶ欄がない。
  代わりに承認済みの学びの本文そのもの（`learnings`）を、認証なしの本文（最大32KB）から信用して受け取る旧経路がある。
  この経路は、統合PRで塞ぐ。
- 統合PRは、次のどちらかで接続する。いずれも、サーバーが `resolveSelectedLearnings` で確定した学びだけをGeminiへ渡す。
  1. 認証必須で、選択 `{ id, version }[]` だけを受ける専用ルートを設ける。
  2. 既存ルートに選択の欄を追加し、本文由来の `learnings` は受け付けない（または無視する）。
- 画面は `409 selection_changed` を受けたら一覧を取得し直して選び直しを求め、`503 unavailable` を受けたら
  「学びを使わずに旅程を作る」を案内する。選択を黙って外して生成を続けない。
- 生成後のTripの `learningApplications` を保存する際は、参照した学びの存在・所有者・現行の版を、
  保存トランザクション内で検証する（[保存API](FIRESTORE_PERSISTENCE.md)の#13の項）。

### 適用記録の表示

- 記録の中心は、旅程の `learningApplications`（学びID・対象Stop・説明）。学びの内容が取得できなくても記録は捨てず、
  「内容を取得できません（撤回または変更された可能性があります）」と示す。「記録がありません」と誤って伝えない。
- 説明文はAI（Gemini）の自由文で未検証。「AIによる説明（未検証）」と表示する。
- 表示する学びの内容は**現在**保存されている内容で、生成した時点のスナップショットではない（旅程には本文を保存しない）。
  「現在の内容」と表示する。
