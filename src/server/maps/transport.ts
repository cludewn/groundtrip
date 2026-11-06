import { MapsCallError } from './errors'
import type { MapsAuth } from './auth'

export const MAPS_TIMEOUT_MS = 15_000

export interface MapsTransportDeps {
  auth: MapsAuth
  fetchFn?: typeof fetch
  timeoutMs?: number
}

// Places・Routesへ、JSONのPOSTを1回だけ送る。課金対象のため、自動で再試行しない。
// 応答の中身は検証せず、JSONとして解釈した値（unknown）を返す。検証は各アダプターが行う。
export async function postJson(
  deps: MapsTransportDeps,
  request: { url: string; body: unknown; fieldMask: string },
): Promise<unknown> {
  const { auth, fetchFn = fetch, timeoutMs = MAPS_TIMEOUT_MS } = deps
  const authHeaders = await auth.getHeaders()

  let response: Response
  let text: string
  try {
    response = await fetchFn(request.url, {
      method: 'POST',
      headers: {
        ...authHeaders,
        // 日本語のクエリをUTF-8で送ることを明示する。
        'Content-Type': 'application/json; charset=utf-8',
        // 請求は要求したフィールドで決まる。必要最小限だけを指定する。
        'X-Goog-FieldMask': request.fieldMask,
      },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    text = await response.text()
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new MapsCallError('timeout', 'Google Maps Platformの応答がタイムアウトしました', {
        cause,
      })
    }
    throw new MapsCallError('network', 'Google Maps Platformへ接続できませんでした', { cause })
  }

  if (!response.ok) {
    throw new MapsCallError('api_error', 'Google Maps Platformがエラーを返しました', {
      status: response.status,
      apiStatus: extractApiStatus(text),
    })
  }
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new MapsCallError(
      'invalid_response',
      'Google Maps Platformの応答を解釈できませんでした',
      {
        status: response.status,
        cause,
      },
    )
  }
}

// Googleのエラー本文（{"error":{"status":"PERMISSION_DENIED"}}）から、状態名だけを取り出す。
function extractApiStatus(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const error = parsed.error
      if (typeof error === 'object' && error !== null && 'status' in error) {
        const status = error.status
        if (typeof status === 'string' && /^[A-Z_]{1,40}$/.test(status)) return status
      }
    }
  } catch {
    // 本文がJSONでなければ、状態名なし。
  }
  return undefined
}
