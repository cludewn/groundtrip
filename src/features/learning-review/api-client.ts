import { z } from 'zod'

import {
  LearningSchema,
  ProposalFailureSchema,
  type Learning,
  type Revision,
  type Trip,
} from '@/domain'
import { getProtectedApiHeaders } from '@/lib/auth/protected-api'
import {
  classifyProtectedHeaderError,
  classifyProtectedStatus,
  PROTECTED_FAILURE_MESSAGES,
} from '@/lib/auth/protected-api-errors'

// 学びの候補の作成API（POST /api/learnings/candidates）を呼ぶクライアント。
// 応答は契約で検証する。候補は1〜3件で、すべて未承認でなければ採用しない
// （承認済みとして返ってきた学びを、本人の承認なしに受け入れない）。

export const LEARNING_CANDIDATES_ENDPOINT = '/api/learnings/candidates'

export type CandidatesFailureKind =
  | 'no_candidates'
  | 'insufficient_information'
  | 'external_service_error'
  | 'invalid_request'
  | 'payload_too_large'
  | 'service_unavailable'
  | 'unauthorized'
  | 'rate_limited'
  | 'auth_required'
  | 'app_check_unavailable'
  | 'interrupted'
  | 'unexpected'

export interface CandidatesFailure {
  kind: CandidatesFailureKind
  message: string
}

export type CandidatesResult =
  { ok: true; learnings: Learning[] } | { ok: false; failure: CandidatesFailure }

export interface CandidatesRequest {
  trip: Trip
  revisions: Revision[]
  feedback: string
}

export interface CandidatesOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  // 既定は本人のBearer＋App Check。テストでは差し替える。
  getHeaders?: () => Promise<Headers>
}

const ProposedSchema = z.strictObject({
  status: z.literal('proposed'),
  learnings: z
    .array(LearningSchema.refine((learning) => learning.approval.status === 'pending'))
    .min(1)
    .max(3)
    // 同じIDの候補があると、承認の操作が、意図しない候補にも作用する。
    .refine(
      (learnings) => new Set(learnings.map((learning) => learning.id)).size === learnings.length,
    ),
})
const ApiErrorSchema = z.object({ status: z.string(), message: z.string() })

const EXPECTED_HTTP_STATUS = {
  no_candidates: 422,
  insufficient_information: 422,
  external_service_error: 502,
  invalid_request: 400,
  payload_too_large: 413,
  service_unavailable: 503,
} as const

const failure = (kind: CandidatesFailureKind, message: string): CandidatesResult => ({
  ok: false,
  failure: { kind, message },
})

const UNEXPECTED_MESSAGE = 'サーバーから想定外の応答が返されました。'
const INTERRUPTED_MESSAGE = '通信が中断されました。接続を確認して、もう一度お試しください。'

export async function requestLearningCandidates(
  request: CandidatesRequest,
  { fetchFn = fetch, signal, getHeaders = getProtectedApiHeaders }: CandidatesOptions = {},
): Promise<CandidatesResult> {
  // ヘッダーを用意できなければ送信しない（課金APIを呼ばない・再試行しない）。
  let headers: Headers
  try {
    headers = await getHeaders()
  } catch (error) {
    const kind = classifyProtectedHeaderError(error)
    return failure(kind, PROTECTED_FAILURE_MESSAGES[kind])
  }
  headers.set('Content-Type', 'application/json')

  let response: Response
  let text: string
  try {
    response = await fetchFn(LEARNING_CANDIDATES_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal,
    })
    text = await response.text()
  } catch {
    return failure('interrupted', INTERRUPTED_MESSAGE)
  }

  // 認証・利用制限は本文を見ずステータスで判定し、固定の文言を出す。
  const protectedFailure = classifyProtectedStatus(response.status)
  if (protectedFailure)
    return failure(protectedFailure, PROTECTED_FAILURE_MESSAGES[protectedFailure])

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return failure('unexpected', UNEXPECTED_MESSAGE)
  }

  const proposed = ProposedSchema.safeParse(body)
  if (proposed.success) {
    return response.status === 200
      ? { ok: true, learnings: proposed.data.learnings }
      : failure('unexpected', UNEXPECTED_MESSAGE)
  }

  const known = ProposalFailureSchema.safeParse(body)
  if (known.success) {
    const { status, message } = known.data
    return response.status === EXPECTED_HTTP_STATUS[status]
      ? failure(status, message)
      : failure('unexpected', UNEXPECTED_MESSAGE)
  }

  const apiError = ApiErrorSchema.safeParse(body)
  if (apiError.success) {
    const { status, message } = apiError.data
    if (
      (status === 'invalid_request' ||
        status === 'payload_too_large' ||
        status === 'service_unavailable') &&
      response.status === EXPECTED_HTTP_STATUS[status]
    ) {
      return failure(status, message)
    }
  }
  return failure('unexpected', UNEXPECTED_MESSAGE)
}
