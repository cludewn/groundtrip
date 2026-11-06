import { z } from 'zod'

import { GenerateTripResponseSchema, type GenerateTripRequest, type Trip } from '@/domain'

// 旅程生成API（POST /api/trips/generate）を呼ぶクライアント。
// 応答は必ず共通契約で検証し、契約に反するものは「想定外」として扱う。
// 認証情報はクライアントへ持ち込まない（外部サービスへの接続はサーバー側で行う）。

export const GENERATE_TRIP_ENDPOINT = '/api/trips/generate'

// 画面が区別して案内する失敗の種類。
// 共通契約の失敗（生成できない／情報不足／外部サービス失敗）に、通信側の失敗を加える。
export type GenerationFailureKind =
  | 'no_candidates'
  | 'insufficient_information'
  | 'external_service_error'
  | 'invalid_request'
  | 'interrupted'
  | 'unexpected'

export interface GenerationFailure {
  kind: GenerationFailureKind
  message: string
}

export type GenerationResult = { ok: true; trip: Trip } | { ok: false; failure: GenerationFailure }

export interface GenerationOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
}

// 共通契約の外にある、API層だけのエラー本文（入力不備・サイズ超過・内部エラー等）。
const ApiLayerErrorSchema = z.object({ status: z.string(), message: z.string() })

const failure = (kind: GenerationFailureKind, message: string): GenerationResult => ({
  ok: false,
  failure: { kind, message },
})

const UNEXPECTED_MESSAGE = 'サーバーから想定外の応答が返されました。'

export async function requestTripGeneration(
  request: GenerateTripRequest,
  { fetchFn = fetch, signal }: GenerationOptions = {},
): Promise<GenerationResult> {
  let response: Response
  try {
    response = await fetchFn(GENERATE_TRIP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    })
  } catch {
    // 接続できない・途中で切れた・利用者の操作で中止した場合。応答は得られていない。
    return failure('interrupted', '通信が中断されました。接続を確認して、もう一度お試しください。')
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return failure('unexpected', UNEXPECTED_MESSAGE)
  }

  const contract = GenerateTripResponseSchema.safeParse(body)
  if (contract.success) {
    // 200以外で提案が返ることは契約上ありえない。HTTPの状態と本文が食い違う応答は採用しない。
    if (contract.data.status === 'proposed') {
      return response.ok
        ? { ok: true, trip: contract.data.trip }
        : failure('unexpected', UNEXPECTED_MESSAGE)
    }
    return failure(contract.data.status, contract.data.message)
  }

  const apiError = ApiLayerErrorSchema.safeParse(body)
  if (apiError.success && apiError.data.status === 'invalid_request') {
    return failure('invalid_request', apiError.data.message)
  }
  return failure('unexpected', UNEXPECTED_MESSAGE)
}
