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
  // 認証（ADCのトークン取得）と、Mapsへの送受信の合計に、1つの期限（timeoutMs）を設ける。
  // 経過時間は、単調時計（performance.now）で測る。イベントループが遅れて、期限のタイマーが実行されなくても、
  // 期限を過ぎたあとの認証の成功を、有効として扱わない（Mapsへの送信の直前にも、期限を確認する）。
  const startedAt = performance.now()
  const remaining = () => timeoutMs - (performance.now() - startedAt)

  let authHeaders: Record<string, string>
  try {
    authHeaders = await withDeadline(auth.getHeaders(), timeoutMs)
  } catch (error) {
    if (error instanceof MapsCallError) throw error
    // 認証の実装が、通常の例外を投げた場合も、元の例外を伝播させず、安全な分類へ変換する。
    throw new MapsCallError('auth_failed', 'Google Maps Platformの認証に失敗しました')
  }
  if (remaining() <= 0) {
    throw new MapsCallError('timeout', 'Google Maps Platformの認証がタイムアウトしました')
  }

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
      // 認証に使った時間を除いた、残りの時間。
      signal: AbortSignal.timeout(Math.max(1, Math.floor(remaining()))),
    })
    text = await response.text()
  } catch (error) {
    // 外部由来の例外は、名前の判定だけに使い、保持も再送出もしない。
    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new MapsCallError('timeout', 'Google Maps Platformの応答がタイムアウトしました')
    }
    throw new MapsCallError('network', 'Google Maps Platformへ接続できませんでした')
  }

  if (!response.ok) {
    throw new MapsCallError('api_error', 'Google Maps Platformがエラーを返しました', {
      status: response.status,
      apiStatus: extractApiStatus(text),
    })
  }
  try {
    return JSON.parse(text)
  } catch {
    // JSON解析エラーのメッセージには、応答本文の断片が含まれ得るため、保持しない。
    throw new MapsCallError(
      'invalid_response',
      'Google Maps Platformの応答を解釈できませんでした',
      {
        status: response.status,
      },
    )
  }
}

// 認証など、時間のかかる準備に期限を設ける。期限が切れたら、timeoutとして失敗させる。
// 元の処理は止められないが、結果は捨てる（期限後に完了しても、呼び出し側は先へ進まない）。
function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new MapsCallError('timeout', 'Google Maps Platformの認証がタイムアウトしました')),
      timeoutMs,
    )
  })
  // 期限後に元の処理が失敗しても、未処理の拒否にしない。
  promise.catch(() => undefined)
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

// Googleのエラー本文（{"error":{"status":"PERMISSION_DENIED"}}）から、状態名だけを取り出す。
// Googleのエラー状態名は、既知の正規コード（Google APIの共通のエラーコード）だけを保持する。
// 文字種・長さだけで通すと、エラー本文に含まれる任意の文字列を保持してしまうため、許可リストにする。
const KNOWN_API_STATUSES: ReadonlySet<string> = new Set([
  'INVALID_ARGUMENT',
  'FAILED_PRECONDITION',
  'OUT_OF_RANGE',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'ABORTED',
  'ALREADY_EXISTS',
  'RESOURCE_EXHAUSTED',
  'CANCELLED',
  'DATA_LOSS',
  'UNKNOWN',
  'INTERNAL',
  'UNIMPLEMENTED',
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
])

function extractApiStatus(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const error = parsed.error
      if (typeof error === 'object' && error !== null && 'status' in error) {
        const status = error.status
        if (typeof status === 'string' && KNOWN_API_STATUSES.has(status)) return status
      }
    }
  } catch {
    // 本文がJSONでなければ、状態名なし。
  }
  return undefined
}
