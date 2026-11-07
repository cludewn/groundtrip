import { z } from 'zod'

import {
  ApprovedLearningSchema,
  RevisionSchema,
  TripSchema,
  type ApprovedLearning,
  type Revision,
  type Trip,
} from '@/domain'
import { getAuthHeaders } from '@/lib/auth/client'
import {
  ApproveLearningBodySchema,
  LearningListResponseSchema,
  VersionedLearningSchema,
  type VersionedLearning,
} from '@/server/persistence/contracts'

import type { LearningStore, SaveResult } from '@/features/learning-review/store'

const ListInfoSchema = z.strictObject({
  returned: z.int().nonnegative(),
  skippedInvalid: z.int().nonnegative(),
  truncated: z.boolean(),
})
const TripListSchema = z.strictObject({
  trips: z.array(TripSchema),
  listInfo: ListInfoSchema,
})
const TripResponseSchema = z.strictObject({ trip: TripSchema })
const RevisionListSchema = z.strictObject({
  revisions: z.array(RevisionSchema),
  listInfo: ListInfoSchema,
})
const ErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})

export type TripList = z.infer<typeof TripListSchema>
export type LearningList = z.infer<typeof LearningListResponseSchema>
export type ReflectionHistory = { trip: Trip; revisions: Revision[] }

// サーバーが返す固定コードに加え、この画面の検査で止めた理由（別の旅程の学びIDとの重複）も同じ形で表す。
export const ID_COLLISION_CODE = 'id_collision'

export class ReflectionApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ReflectionApiError'
  }
}

const INTERRUPTED_MESSAGE = '通信に失敗しました。接続を確認して、もう一度お試しください。'
const INVALID_RESPONSE_MESSAGE = '保存サービスから想定外の応答が返されました。'
const PARTIAL_LIST_MESSAGE =
  '保存データの一覧をすべて確認できませんでした。誤った記録を使わないため、操作を中止しました。'

// サーバーのエラー本文を読めないとき（プロキシのHTMLエラーなど）に、ステータスだけで選ぶ案内。
function fallbackMessage(status: number): string {
  if (status === 401) {
    return '認証を確認できません。以前の匿名データを復元できるか確認してください。'
  }
  if (status === 409)
    return '保存した内容がほかの操作で更新されました。最新の内容を確認してください。'
  if (status === 503) return '保存機能は現在利用できません。時間をおいて、もう一度お試しください。'
  if (status === 502 || status === 504) {
    return '保存サービスに接続できませんでした。時間をおいて、もう一度お試しください。'
  }
  return '保存データを取得・更新できませんでした。'
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function authorizedJson<T>(
  path: string,
  schema: z.ZodType<T>,
  options: {
    method?: 'GET' | 'POST'
    body?: unknown
    signal?: AbortSignal
    fetchFn?: typeof fetch
  } = {},
): Promise<T> {
  const { method = 'GET', body, signal, fetchFn = fetch } = options
  // 認証が失敗しても新しい匿名ユーザーを勝手に作らない。
  const headers = await getAuthHeaders()
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  if (signal?.aborted) throw new ReflectionApiError(INTERRUPTED_MESSAGE)

  let response: Response
  let text: string
  try {
    response = await fetchFn(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal,
    })
    text = await response.text()
  } catch {
    throw new ReflectionApiError(INTERRUPTED_MESSAGE)
  }
  if (signal?.aborted) throw new ReflectionApiError(INTERRUPTED_MESSAGE)

  const json = parseJson(text)
  // 本文がJSONかどうかより先にステータスを見る。プロキシが返すHTMLの502/503でも、状況に合う案内を使う。
  if (!response.ok) {
    const error = ErrorSchema.safeParse(json)
    if (error.success) {
      throw new ReflectionApiError(error.data.error.message, response.status, error.data.error.code)
    }
    throw new ReflectionApiError(fallbackMessage(response.status), response.status)
  }
  if (json === undefined) throw new ReflectionApiError(INVALID_RESPONSE_MESSAGE, response.status)
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new ReflectionApiError(INVALID_RESPONSE_MESSAGE, response.status)
  return parsed.data
}

export async function loadSavedTrips(
  options: { signal?: AbortSignal; fetchFn?: typeof fetch } = {},
): Promise<TripList> {
  return authorizedJson('/api/trips', TripListSchema, options)
}

export async function loadReflectionHistory(
  tripId: string,
  options: { signal?: AbortSignal; fetchFn?: typeof fetch } = {},
): Promise<ReflectionHistory> {
  const id = encodeURIComponent(tripId)
  const [trip, revisions] = await Promise.all([
    authorizedJson('/api/trips/' + id, TripResponseSchema, options),
    authorizedJson('/api/trips/' + id + '/revisions', RevisionListSchema, options),
  ])
  if (
    trip.trip.id !== tripId ||
    revisions.listInfo.skippedInvalid > 0 ||
    revisions.listInfo.truncated ||
    revisions.revisions.some((revision) => revision.tripId !== tripId)
  ) {
    throw new ReflectionApiError(PARTIAL_LIST_MESSAGE)
  }
  return { trip: trip.trip, revisions: revisions.revisions }
}

export async function loadSavedLearnings(
  options: { signal?: AbortSignal; fetchFn?: typeof fetch } = {},
): Promise<LearningList> {
  return authorizedJson('/api/learnings', LearningListResponseSchema, options)
}

// 内容が同じ学びか。適用範囲は、キーの並び順に依存しないよう、項目ごとに比べる。
export function sameLearning(a: ApprovedLearning, b: ApprovedLearning): boolean {
  const sameScope =
    a.scope.kind === 'all_trips'
      ? b.scope.kind === 'all_trips'
      : b.scope.kind === 'region' && a.scope.region === b.scope.region
  return (
    a.sourceTripId === b.sourceTripId &&
    a.category === b.category &&
    a.content === b.content &&
    sameScope
  )
}

type SaveFailure = Extract<SaveResult, { ok: false }>

// 再試行しても直らない失敗。保存できない理由を言い切り、「再読み込み」は版の食い違いのときだけ案内する
// （再読み込みは、画面の承認と入力を消すため）。
const NON_RETRYABLE_REASONS: Readonly<Record<string, string>> = {
  version_conflict:
    '保存済みの学びが、ほかの操作で更新されていました。上書きを防ぐため、保存を止めました。' +
    'ページを再読み込みすると最新の内容を確認できますが、いまの承認と入力した内容は消えます。',
  already_exists:
    '同じIDの学びが、ほかの操作で先に保存されていました。上書きを防ぐため、保存を止めました。' +
    'ページを再読み込みすると最新の内容を確認できますが、いまの承認と入力した内容は消えます。',
  storage_limit_reached:
    '保存できる学びの数が上限に達しているため、新しい学びは保存できません。' +
    'もう一度保存しても、結果は変わりません。',
  learning_revoked:
    '撤回済みの学びと同じIDのため、保存できません。もう一度保存しても保存されません。' +
    '学びの候補を作り直して、新しい学びとして承認してください。',
  [ID_COLLISION_CODE]:
    '別の旅行で使われている学びIDと重複しているため、保存できません。' +
    'もう一度保存しても保存されません。学びの候補を作り直してください。',
}

function describeSaveFailure(error: unknown, savedIds: readonly string[]): SaveFailure {
  const code = error instanceof ReflectionApiError ? error.code : undefined
  const fixed = code === undefined ? undefined : NON_RETRYABLE_REASONS[code]
  const reason =
    fixed ??
    (error instanceof ReflectionApiError
      ? error.message
      : error instanceof z.ZodError
        ? '入力した学びの内容が保存条件を満たしていません。'
        : error instanceof Error
          ? error.message
          : '保存に失敗しました。')
  const prefix = savedIds.length > 0 ? String(savedIds.length) + '件は保存済みです。' : ''
  return { ok: false, message: prefix + reason, savedIds, retryable: fixed === undefined }
}

// LearningReviewが要求する全件保存ポート。各候補の成功を確認するまで保存完了としない。
// APIは1件ずつなので、一部成功したときは再取得して成功分のversionを引き継いで再試行する。
// 1件でも保存できたときは、成功・失敗にかかわらずonSavedを呼ぶ（保存済みの一覧を取り直し、画面を事実に合わせる）。
export function createFirestoreLearningStore(
  onSaved?: () => void,
  fetchFn: typeof fetch = fetch,
): LearningStore {
  // この画面で確認した版だけを更新する。別端末が更新した版へ勝手に追随しない。
  const observed = new Map<string, VersionedLearning>()
  return {
    async save(approved, options): Promise<SaveResult> {
      if (approved.length === 0) {
        return { ok: false, message: '承認された学びがありません。' }
      }
      const ids = new Set(approved.map((learning) => learning.id))
      if (
        ids.size !== approved.length ||
        approved.some((item) => !ApprovedLearningSchema.safeParse(item).success)
      ) {
        return { ok: false, message: '学びの形式またはIDを確認できませんでした。' }
      }
      // 保存できた（またはすでに同じ内容で保存されていた）学びのID。
      const savedIds: string[] = []
      try {
        const saved = await loadSavedLearnings({ signal: options?.signal, fetchFn })
        if (saved.listInfo.skippedInvalid || saved.listInfo.truncated) {
          throw new ReflectionApiError(PARTIAL_LIST_MESSAGE)
        }
        const current = new Map(saved.learnings.map((entry) => [entry.learning.id, entry]))
        for (const learning of approved) {
          if (options?.signal?.aborted) throw new ReflectionApiError(INTERRUPTED_MESSAGE)
          const existing = current.get(learning.id)
          if (
            existing &&
            (existing.learning.sourceTripId !== learning.sourceTripId ||
              existing.learning.category !== learning.category)
          ) {
            throw new ReflectionApiError(
              '別の旅程で使われている学びIDと重複しています。',
              undefined,
              ID_COLLISION_CODE,
            )
          }
          if (existing && sameLearning(existing.learning, learning)) {
            observed.set(learning.id, existing)
            savedIds.push(learning.id)
            continue
          }
          if (existing) {
            const previous = observed.get(learning.id)
            if (
              !previous ||
              previous.version !== existing.version ||
              !sameLearning(previous.learning, existing.learning)
            ) {
              throw new ReflectionApiError(
                '保存済みの学びが別の操作で変更されています。確認してから再度編集してください。',
                409,
                'version_conflict',
              )
            }
          }
          const body = ApproveLearningBodySchema.parse({
            expectedVersion: existing?.version ?? 0,
            sourceTripId: learning.sourceTripId,
            category: learning.category,
            content: learning.content,
            scope: learning.scope,
          })
          const result: VersionedLearning = await authorizedJson(
            '/api/learnings/' + encodeURIComponent(learning.id) + '/approve',
            VersionedLearningSchema,
            { method: 'POST', body, signal: options?.signal, fetchFn },
          )
          if (!sameLearning(result.learning, learning)) {
            throw new ReflectionApiError(INVALID_RESPONSE_MESSAGE)
          }
          current.set(learning.id, result)
          observed.set(learning.id, result)
          savedIds.push(learning.id)
        }
        return { ok: true }
      } catch (error) {
        return describeSaveFailure(error, savedIds)
      } finally {
        if (savedIds.length > 0) onSaved?.()
      }
    },
  }
}
