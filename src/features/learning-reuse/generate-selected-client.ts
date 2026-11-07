import type { GenerateTripRequest } from '@/domain'
import { getAuthHeaders } from '@/lib/auth/client'
import {
  requestTripGeneration,
  type GenerationOptions,
  type GenerationResult,
} from '@/features/trip-planner/api-client'

// IDだけを渡す。学びの内容・承認状態はサーバーで本人の保存済みデータから再検証する。
export async function requestTripWithSelectedLearnings(
  request: GenerateTripRequest,
  selectedLearningIds: readonly string[],
  options: GenerationOptions = {},
): Promise<GenerationResult> {
  if (selectedLearningIds.length === 0) return requestTripGeneration(request, options)
  if (options.signal?.aborted) {
    return { ok: false, failure: { kind: 'interrupted', message: '通信を中断しました。' } }
  }
  let headers: Headers
  try {
    headers = await getAuthHeaders()
  } catch {
    return {
      ok: false,
      failure: {
        kind: 'auth_required',
        message: '保存した学びを使うには、本人の認証状態を確認してください。',
      },
    }
  }
  return requestTripGeneration(request, {
    ...options,
    endpoint: '/api/trips/generate-selected',
    payload: { request: { ...request, learnings: [] }, selectedLearningIds },
    headers,
  })
}
