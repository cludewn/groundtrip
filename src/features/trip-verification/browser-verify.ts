import { requestTripVerification, type VerificationResult } from './api-client'
import type { Trip } from '@/domain'

// 画面から照合APIを呼ぶ入口。認証ヘッダーを付ける場所は、ここの1か所だけにする。
//
// 課金APIの保護（認証）はIssue #29で決める。仕様が決まるまでは、トークンを付けず、従来どおりの呼び出しにする。
// 決まったら、`withAuthHeaders(fetch, getAuthHeaders)`（src/lib/auth/client.ts）を渡すだけで足りる。
export type AuthHeadersProvider = () => Promise<Headers | undefined>

export function withAuthHeaders(
  base: typeof fetch,
  getHeaders?: AuthHeadersProvider,
): typeof fetch {
  if (!getHeaders) return base
  return async (input, init) => {
    let extra: Headers | undefined
    try {
      extra = await getHeaders()
    } catch {
      // トークンを取得できなくても、呼び出しの挙動は変えない（ヘッダーなしで送り、判断はサーバーに任せる）。
      extra = undefined
    }
    if (!extra) return base(input, init)
    const headers = new Headers(init?.headers)
    extra.forEach((value, key) => headers.set(key, value))
    return base(input, { ...init, headers })
  }
}

// fetchはグローバルを呼び出し時に参照する（テストでの差し替えを妨げない）。
const browserFetch: typeof fetch = (input, init) => fetch(input, init)

export function verifyTripFromBrowser(
  trip: Trip,
  options: { signal?: AbortSignal } = {},
): Promise<VerificationResult> {
  return requestTripVerification(trip, {
    ...options,
    fetchFn: withAuthHeaders(browserFetch),
  })
}
