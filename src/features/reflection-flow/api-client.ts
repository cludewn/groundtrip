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

async function authorizedJson<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal; fetchFn?: typeof fetch } = {},
): Promise<T> {
  const { method = 'GET', body, signal, fetchFn = fetch } = options
  // 認証が失敗しても新しい匿名ユーザーを勝手に作らない。
  const headers = await getAuthHeaders()
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  if (signal?.aborted) throw new ReflectionApiError(INTERRUPTED_MESSAGE)

  let response: Response
  try {
    response = await fetchFn(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal,
    })
  } catch {
    throw new ReflectionApiError(INTERRUPTED_MESSAGE)
  }
  if (signal?.aborted) throw new ReflectionApiError(INTERRUPTED_MESSAGE)

  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw new ReflectionApiError(INVALID_RESPONSE_MESSAGE, response.status)
  }
  if (!response.ok) {
    const error = ErrorSchema.safeParse(json)
    const fallback =
      response.status === 401
        ? '認証を確認できません。以前の匿名データを復元できるか確認してください。'
        : response.status === 409
          ? '保存した内容がほかの操作で更新されました。再読み込みして確認してください。'
          : response.status === 503
            ? '保存機能は現在利用できません。'
            : '保存データを取得・更新できませんでした。'
    throw new ReflectionApiError(
      error.success ? error.data.error.message : fallback,
      response.status,
      error.success ? error.data.error.code : undefined,
    )
  }
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

function sameLearning(a: ApprovedLearning, b: ApprovedLearning): boolean {
  return (
    a.sourceTripId === b.sourceTripId &&
    a.category === b.category &&
    a.content === b.content &&
    JSON.stringify(a.scope) === JSON.stringify(b.scope)
  )
}

// LearningReviewが要求する全件保存ポート。各候補の成功を確認するまで保存完了としない。
// APIは1件ずつなので、一部成功したときは再取得して成功分のversionを引き継いで再試行する。
export function createFirestoreLearningStore(
  onSaved?: () => void,
  fetchFn: typeof fetch = fetch,
): LearningStore {
  return {
    async save(approved, options): Promise<SaveResult> {
      if (approved.length === 0) {
        return { ok: false, message: '承認された学びがありません。' }
      }
      const ids = new Set(approved.map((learning) => learning.id))
      if (ids.size !== approved.length || approved.some((item) => !ApprovedLearningSchema.safeParse(item).success)) {
        return { ok: false, message: '学びの形式またはIDを確認できませんでした。' }
      }
      let completed = 0
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
            throw new ReflectionApiError('別の旅程で使われている学びIDと重複しています。')
          }
          if (existing && sameLearning(existing.learning, learning)) {
            completed += 1
            continue
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
          completed += 1
        }
        onSaved?.()
        return { ok: true }
      } catch (error) {
        const reason =
          error instanceof ReflectionApiError
            ? error.message
            : error instanceof z.ZodError
              ? '入力した学びの内容が保存条件を満たしていません。'
              : error instanceof Error
                ? error.message
                : '保存に失敗しました。'
        const prefix =
          completed > 0
            ? String(completed) + '件は保存されましたが、残りを確認できませんでした。'
            : ''
        return { ok: false, message: prefix + reason + ' 再読み込みして確認してください。' }
      }
    },
  }
}
