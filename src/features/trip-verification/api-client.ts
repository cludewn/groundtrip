import { z } from 'zod'

import { TripSchema, type Trip } from '@/domain'

// 旅程の照合API（POST /api/trips/verify）を呼ぶクライアント。
// 応答は必ず共通契約で検証し、契約に反するものは「想定外」として扱う。
// 照合は旅程に根拠を付けるだけで、予定・時刻・固定の内容は変えない。変えて返された応答は採用しない。

export const VERIFY_TRIP_ENDPOINT = '/api/trips/verify'

export type VerificationFailureKind =
  | 'external_service_error'
  | 'invalid_request'
  | 'payload_too_large'
  | 'service_unavailable'
  | 'interrupted'
  | 'unexpected'

export interface VerificationFailure {
  kind: VerificationFailureKind
  message: string
}

export type VerificationResult =
  { ok: true; trip: Trip } | { ok: false; failure: VerificationFailure }

export interface VerificationOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
}

const VerifiedSchema = z.object({ status: z.literal('verified'), trip: TripSchema })
const ErrorBodySchema = z.object({ status: z.string(), message: z.string() })

const EXPECTED_HTTP_STATUS = {
  external_service_error: 502,
  invalid_request: 400,
  payload_too_large: 413,
  service_unavailable: 503,
} as const

const failure = (kind: VerificationFailureKind, message: string): VerificationResult => ({
  ok: false,
  failure: { kind, message },
})

const UNEXPECTED_MESSAGE = 'サーバーから想定外の応答が返されました。'
const INTERRUPTED_MESSAGE = '通信が中断されました。接続を確認して、もう一度お試しください。'

// 照合の応答が、送った旅程の「根拠（placeIdと証拠）だけ」を変えたものか。
// 予定の内容・時刻・固定・学びの反映が変わっていれば採用しない。
const contentOf = (trip: Trip): string =>
  JSON.stringify([
    trip.id,
    trip.version,
    trip.date,
    trip.region,
    trip.timeZone,
    trip.preferences,
    trip.stops.map((stop) => [
      stop.id,
      stop.name,
      stop.plannedStartTime,
      stop.durationMinutes,
      stop.isFixed,
      // 種別も、照合では変わらない。変更・削除・追加された応答は採用しない。
      stop.kind ?? null,
    ]),
    trip.learningApplications,
  ])

const sameAsSent = (sent: Trip, received: Trip): boolean => contentOf(sent) === contentOf(received)

export async function requestTripVerification(
  trip: Trip,
  { fetchFn = fetch, signal }: VerificationOptions = {},
): Promise<VerificationResult> {
  let response: Response
  let text: string
  try {
    response = await fetchFn(VERIFY_TRIP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trip }),
      signal,
    })
    text = await response.text()
  } catch {
    return failure('interrupted', INTERRUPTED_MESSAGE)
  }

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return failure('unexpected', UNEXPECTED_MESSAGE)
  }

  const verified = VerifiedSchema.safeParse(body)
  if (verified.success) {
    return response.status === 200 && sameAsSent(trip, verified.data.trip)
      ? { ok: true, trip: verified.data.trip }
      : failure('unexpected', UNEXPECTED_MESSAGE)
  }

  const error = ErrorBodySchema.safeParse(body)
  if (error.success) {
    const { status, message } = error.data
    if (
      (status === 'external_service_error' ||
        status === 'invalid_request' ||
        status === 'payload_too_large' ||
        status === 'service_unavailable') &&
      response.status === EXPECTED_HTTP_STATUS[status]
    ) {
      return failure(status, message)
    }
  }
  return failure('unexpected', UNEXPECTED_MESSAGE)
}
