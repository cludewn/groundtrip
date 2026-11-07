import { getAuthHeaders } from '@/lib/auth/client'
import { LearningListResponseSchema, type VersionedLearning } from '@/server/persistence/contracts'

// 本人の保存済みの学びを取得する。取得失敗や不完全な一覧を空配列として扱わない。
export type LearningLoadResult =
  | { ok: true; items: VersionedLearning[] }
  | {
      ok: false
      kind: 'session' | 'unavailable' | 'interrupted' | 'incomplete' | 'unexpected'
      message: string
    }

export interface LearningLoadOptions {
  signal?: AbortSignal
  fetchFn?: typeof fetch
  getHeaders?: () => Promise<Headers>
}

const fail = (
  kind: Extract<LearningLoadResult, { ok: false }>['kind'],
  message: string,
): LearningLoadResult => ({ ok: false, kind, message })

export async function loadApprovedLearningOptions({
  signal,
  fetchFn = fetch,
  getHeaders = getAuthHeaders,
}: LearningLoadOptions = {}): Promise<LearningLoadResult> {
  let headers: Headers
  try {
    headers = await getHeaders()
    if (signal?.aborted) return fail('interrupted', '読み込みを中断しました。')
  } catch {
    return fail('session', '認証状態を確認できません。ログイン状態を確認してください。')
  }

  let response: Response
  try {
    response = await fetchFn('/api/learnings', {
      method: 'GET',
      headers,
      signal,
      cache: 'no-store',
    })
  } catch {
    return fail('interrupted', '通信できませんでした。接続を確認して再試行してください。')
  }

  if (response.status === 401 || response.status === 403) {
    return fail('session', '認証状態を確認できません。ログイン状態を確認してください。')
  }
  if (response.status === 503) {
    return fail('unavailable', '保存済みの学びを現在取得できません。')
  }
  if (response.status !== 200) {
    return fail('unexpected', '学びの読み込みに失敗しました。')
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return fail('unexpected', 'サーバーからの応答を読み取れませんでした。')
  }
  const parsed = LearningListResponseSchema.safeParse(body)
  if (!parsed.success) {
    return fail('incomplete', '学びの一覧を安全に確認できません。')
  }
  const { learnings, listInfo } = parsed.data
  if (
    listInfo.truncated ||
    listInfo.skippedInvalid > 0 ||
    listInfo.returned !== learnings.length ||
    new Set(learnings.map(({ learning }) => learning.id)).size !== learnings.length
  ) {
    return fail('incomplete', '学びの一覧に未取得または不正な項目があります。')
  }
  return { ok: true, items: learnings }
}
