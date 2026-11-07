import type { ApprovedLearning } from '@/domain'

// 承認済みの学びの保存の接続口（ポート）。画面（LearningReview）は、この型にだけ依存する。
// 実際の保存（Firestore・認証）は、この型を満たす実装を、`store` として差し込む。
//
// 契約：
// - `approved` は、いま画面で承認済みの、この旅程の学びの全件（差分ではない）。承認済み（approved）だけが渡る。
// - 保存が成功したら `{ ok: true }`、失敗したら `{ ok: false, message }` を返す。`message` は利用者に表示できる日本語にする。
// - 失敗のときは、任意で `savedIds`（失敗するまでに保存できた学びのID）と `retryable`（同じ内容で再試行して
//   直る可能性があるか）を返せる。どちらも省略でき、省略したときの画面の表示は、これまでと同じ。
// - 例外を投げてもよい。画面は「保存できませんでした」として扱い、承認済みの内容と入力中の内容を残す。
// - `options.signal` は、旅程の切り替え・画面の破棄のときに中止される。中止された保存の結果は、画面が採用しない。

export type SaveResult =
  | { ok: true }
  | {
      ok: false
      message: string
      // 失敗するまでに保存できた学びのID。渡されたときだけ、画面は項目ごとに「保存済み／未保存」を示す。
      savedIds?: readonly string[]
      // false のとき、同じ内容でもう一度保存しても結果は変わらない（画面は「もう一度、保存できます」と案内しない）。
      // 省略時は true。
      retryable?: boolean
    }

export interface SaveOptions {
  signal?: AbortSignal
}

export interface LearningStore {
  save: (approved: ApprovedLearning[], options?: SaveOptions) => Promise<SaveResult>
}
