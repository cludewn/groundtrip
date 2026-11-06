// Google Maps Platform（Places・Routes）の呼び出し失敗。HTTP 200の「結果なし」は失敗ではなく、
// 各アダプターが `no_candidates` / `no_route` として返す。ここは「呼び出しそのものの失敗」だけを表す。
// 原因の区分とHTTPステータス、Googleのエラー状態名だけを運び、リクエスト本文・クエリ・トークンは含めない。
export type MapsFailureReason =
  | 'not_configured'
  | 'invalid_request'
  | 'unsupported_mode'
  | 'auth_failed'
  | 'timeout'
  | 'network'
  | 'api_error'
  | 'invalid_response'

export class MapsCallError extends Error {
  readonly reason: MapsFailureReason
  readonly status?: number
  // 例：PERMISSION_DENIED、RESOURCE_EXHAUSTED。診断用で、利用者へは出さない。
  readonly apiStatus?: string

  constructor(
    reason: MapsFailureReason,
    message: string,
    options?: { status?: number; apiStatus?: string; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MapsCallError'
    this.reason = reason
    this.status = options?.status
    this.apiStatus = options?.apiStatus
  }
}
